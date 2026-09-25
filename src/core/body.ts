/**
 * Reading a response body under a byte cap that holds after decompression.
 *
 * Bun's fetch advertises `gzip, deflate, br, zstd` and decodes transparently; a zstd frame is decoded whole before
 * the first chunk reaches the caller, so a 64 KB body became 4 GB of memory before any cap could fire (review 4 H2).
 * Every outgoing request therefore goes out with `decompress: false` and `accept-encoding: gzip, deflate`, and the
 * body is decoded here with a streaming decoder whose output is counted chunk by chunk: the read stops as soon as
 * the decoded size passes the cap. Any other content-encoding is refused.
 */

/** What every client sends. Only codings decoded here, as a stream, under the cap. */
export const ACCEPT_ENCODING = "gzip, deflate";

/** The fetch option that turns off Bun's transparent (unbounded) decoding. */
export const NO_AUTO_DECOMPRESS = { decompress: false } as const;

export type BodyFailure = "too-large" | "unsupported-encoding" | "corrupt";

export class BodyError extends Error {
	constructor(
		readonly kind: BodyFailure,
		message: string,
	) {
		super(message);
		this.name = "BodyError";
	}
}

type Coding = "identity" | "gzip" | "deflate";

/** The one coding a body carries, or a BodyError for anything not decoded here (br, zstd, stacked codings). */
export function codingOf(header: string | null): Coding {
	const codings = (header ?? "")
		.toLowerCase()
		.split(",")
		.map((c) => c.trim())
		.filter((c) => c !== "" && c !== "identity");
	if (codings.length === 0) return "identity";
	const only = codings[0];
	if (codings.length === 1 && (only === "gzip" || only === "x-gzip")) return "gzip";
	if (codings.length === 1 && only === "deflate") return "deflate";
	throw new BodyError(
		"unsupported-encoding",
		`unsupported content-encoding: ${codings.join(", ").slice(0, 60)}`,
	);
}

export interface ReadBodyOptions {
	/** Most decoded bytes accepted. Past it the read stops and throws `too-large` (unless `truncate`). */
	readonly maxBytes: number;
	/** Return the first `maxBytes` decoded bytes instead of failing (a live stream that never ends). */
	readonly truncate?: boolean;
}

/**
 * The decoded body, never holding more than `maxBytes` of it (plus one decoder chunk, at most 64 KiB in Bun).
 * The underlying connection is cancelled whenever the read stops early.
 */
export async function readBody(response: Response, options: ReadBodyOptions): Promise<Uint8Array> {
	const { maxBytes } = options;
	const truncate = options.truncate ?? false;
	const coding = codingOf(response.headers.get("content-encoding"));
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (!truncate && coding === "identity" && declared > maxBytes) {
		await response.body?.cancel().catch(() => {});
		throw new BodyError("too-large", `response too large (${declared} bytes)`);
	}
	if (!response.body) return new Uint8Array();
	const raw = response.body.getReader();
	let stream: ReadableStream<Uint8Array>;
	if (coding === "identity") {
		stream = readerStream(raw, null);
	} else {
		const first = await raw.read();
		if (first.done) return new Uint8Array();
		const format: CompressionFormat =
			coding === "gzip" ? "gzip" : isZlibHeader(first.value) ? "deflate" : "deflate-raw";
		// The compressed input is capped too, so a body that inflates to nothing cannot stream forever.
		stream = readerStream(raw, first.value, truncate ? undefined : maxBytes).pipeThrough(
			new DecompressionStream(format) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
		);
	}
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			let step: Awaited<ReturnType<typeof reader.read>>;
			try {
				step = await reader.read();
			} catch (error) {
				if (error instanceof BodyError) throw error;
				if (coding !== "identity") throw new BodyError("corrupt", `corrupt ${coding} body`);
				throw error;
			}
			if (step.done) break;
			const chunk = step.value;
			if (total + chunk.byteLength > maxBytes) {
				if (!truncate) throw new BodyError("too-large", `response exceeded ${maxBytes} bytes`);
				chunks.push(chunk.subarray(0, maxBytes - total));
				total = maxBytes;
				break;
			}
			total += chunk.byteLength;
			chunks.push(chunk);
			if (truncate && total === maxBytes) break;
		}
	} finally {
		await reader.cancel().catch(() => {});
		await raw.cancel().catch(() => {});
	}
	return concat(chunks, total);
}

/** A pull stream over a reader, optionally starting with a chunk already read, optionally capping raw bytes. */
function readerStream(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	first: Uint8Array | null,
	maxRaw?: number,
): ReadableStream<Uint8Array> {
	let pending = first;
	let seen = 0;
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				let chunk: Uint8Array;
				if (pending) {
					chunk = pending;
					pending = null;
				} else {
					const step = await reader.read();
					if (step.done) {
						controller.close();
						return;
					}
					chunk = step.value;
				}
				seen += chunk.byteLength;
				if (maxRaw !== undefined && seen > maxRaw) {
					controller.error(new BodyError("too-large", `response exceeded ${maxRaw} bytes`));
					await reader.cancel().catch(() => {});
					return;
				}
				controller.enqueue(chunk);
			},
			async cancel(reason) {
				await reader.cancel(reason).catch(() => {});
			},
		},
		{ highWaterMark: 0 },
	);
}

/** RFC 1950 header: compression method 8, window ≤ 32 KiB, header checksum divisible by 31. */
function isZlibHeader(bytes: Uint8Array): boolean {
	const cmf = bytes[0];
	const flg = bytes[1];
	if (cmf === undefined) return false;
	if ((cmf & 0x0f) !== 8 || cmf >> 4 > 7) return false;
	return flg === undefined || ((cmf << 8) | flg) % 31 === 0;
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
	const only = chunks.length === 1 ? chunks[0] : undefined;
	if (only?.byteLength === total) return only;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}
