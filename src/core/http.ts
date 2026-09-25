import pkg from "../../package.json" with { type: "json" };
import { ACCEPT_ENCODING, BodyError, NO_AUTO_DECOMPRESS, readBody } from "./body.ts";
import { HttpError, type HttpLike, type RawResponse, type RequestOptions } from "./types.ts";

/**
 * Project identity with a contact URL, as source policies ask (e.g. Wikimedia's User-Agent policy). Never an email
 * or a person's name: see docs/ETHICS.md.
 */
export const USER_AGENT = `Vigia/${pkg.version} (+https://github.com/elberacasa)`;

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface HttpClientOptions {
	readonly fetchImpl?: typeof fetch;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
	/** Default minimum gap between two requests to the same host. */
	readonly defaultHostGapMs?: number;
}

/**
 * The only way adapters reach the network: one identity, timeouts, a byte cap, bounded retries with
 * backoff that honours Retry-After, and a per-host pace so no source is hammered.
 */
export class HttpClient implements HttpLike {
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #defaultGap: number;
	/** Next time a request to the host may start. Chained so concurrent callers queue. */
	readonly #hostSlots = new Map<string, Promise<void>>();

	constructor(options: HttpClientOptions = {}) {
		this.#fetch = options.fetchImpl ?? fetch;
		this.#now = options.now ?? Date.now;
		this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.#defaultGap = options.defaultHostGapMs ?? 1_000;
	}

	async request(url: string, options: RequestOptions = {}): Promise<RawResponse> {
		const retries = options.retries ?? 2;
		let attempt = 0;
		for (;;) {
			try {
				return await this.#once(url, options);
			} catch (error) {
				const status = error instanceof HttpError ? error.status : 0;
				const retryable = !(error instanceof BodyRefused) && (status === 0 || RETRYABLE.has(status));
				if (!retryable || attempt >= retries || options.signal?.aborted) throw error;
				const retryAfter = error instanceof RetryAfter ? error.ms : 0;
				const backoff = Math.max(retryAfter, 1_000 * 2 ** attempt * (0.75 + Math.random() * 0.5));
				await this.#sleep(Math.min(backoff, 60_000));
				attempt++;
			}
		}
	}

	async #pace(host: string, gapMs: number): Promise<void> {
		const previous = this.#hostSlots.get(host) ?? Promise.resolve();
		let release: () => void = () => {};
		const mine = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.#hostSlots.set(
			host,
			previous.then(() => mine),
		);
		await previous;
		// Hold the slot for gapMs after this request starts.
		setTimeout(release, gapMs);
	}

	async #once(url: string, options: RequestOptions): Promise<RawResponse> {
		const parsed = new URL(url);
		await this.#pace(options.paceKey ?? parsed.host, options.hostGapMs ?? this.#defaultGap);

		const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
		const headers: Record<string, string> = {
			"user-agent": USER_AGENT,
			accept: "*/*",
			"accept-language": "es-VE,es;q=0.9,en;q=0.5",
			...options.headers,
			// Last, so no caller can re-enable a coding that is not decoded under the cap (review 4 H2).
			"accept-encoding": ACCEPT_ENCODING,
		};
		const init: RequestInit & { tls?: { ca: string }; decompress?: boolean } = {
			method: options.method ?? "GET",
			headers,
			signal,
			redirect: "follow",
			...NO_AUTO_DECOMPRESS,
		};
		if (options.body !== undefined) init.body = options.body;
		if (options.ca !== undefined) init.tls = { ca: options.ca };

		let response: Response;
		try {
			response = await this.#fetch(url, init);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new HttpError(`network: ${reason}`, 0, url);
		}

		const ok = response.ok || (options.okStatuses?.includes(response.status) ?? false);
		if (!ok) {
			await response.body?.cancel();
			const retryAfter = parseRetryAfter(response.headers.get("retry-after"), this.#now());
			const message = `HTTP ${response.status} from ${parsed.host}`;
			if (retryAfter !== null) throw new RetryAfter(message, response.status, url, retryAfter);
			throw new HttpError(message, response.status, url);
		}

		let bytes: Uint8Array;
		try {
			bytes =
				options.readBytes !== undefined
					? await readBody(response, { maxBytes: options.readBytes, truncate: true })
					: await readBody(response, { maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES });
		} catch (error) {
			// A refused or oversized body is not retried: the same server would send the same bytes.
			if (error instanceof BodyError) throw new BodyRefused(error.message, 0, url);
			throw error;
		}
		const body = options.binary ? Buffer.from(bytes).toString("base64") : decodeText(bytes, response);
		const etag = response.headers.get("etag");
		const lastModified = response.headers.get("last-modified");
		return {
			url: response.url || url,
			status: response.status,
			contentType: response.headers.get("content-type") ?? "",
			body,
			fetchedAt: this.#now(),
			...(etag ? { etag } : {}),
			...(lastModified ? { lastModified } : {}),
		};
	}
}

/** A body that was too large, corrupt or in a coding not decoded here. */
class BodyRefused extends HttpError {}

class RetryAfter extends HttpError {
	constructor(
		message: string,
		status: number,
		url: string,
		readonly ms: number,
	) {
		super(message, status, url);
	}
}

export function parseRetryAfter(header: string | null, now: number): number | null {
	if (header === null) return null;
	const seconds = Number(header);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
	const date = Date.parse(header);
	if (Number.isNaN(date)) return null;
	return Math.max(0, date - now);
}

/** Honour the declared charset; many Venezuelan sites still serve ISO-8859-1 / Windows-1252. */
export function decodeText(bytes: Uint8Array, response: Pick<Response, "headers">): string {
	const type = response.headers.get("content-type") ?? "";
	const declared = /charset=([\w-]+)/i.exec(type)?.[1]?.toLowerCase();
	let charset = declared;
	if (!charset) {
		const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
		charset = /encoding=["']([\w-]+)["']/i.exec(head)?.[1]?.toLowerCase() ?? "utf-8";
	}
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}
