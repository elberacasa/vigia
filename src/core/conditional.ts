import type { RawResponse } from "./types.ts";

/**
 * Conditional GETs for a file that changes rarely (a weekly spreadsheet, a daily page): the validators of the last
 * response that parsed are sent back as If-None-Match / If-Modified-Since, so an unchanged file costs a 304 with no
 * body. Only a body that parses is remembered: a broken file must be fetched in full next time, not answered with
 * 304 forever. One instance per adapter (module state, like the rss factory's).
 */
export class Conditional {
	#etag: string | null = null;
	#lastModified: string | null = null;

	/** Headers for the next request; empty until a parsed response was remembered. */
	headers(): Record<string, string> {
		return {
			...(this.#etag ? { "if-none-match": this.#etag } : {}),
			...(this.#lastModified ? { "if-modified-since": this.#lastModified } : {}),
		};
	}

	/** Statuses to accept besides 2xx: 304 only when validators were sent. */
	okStatuses(): number[] {
		return this.#etag || this.#lastModified ? [304] : [];
	}

	/**
	 * Remembers `raw`'s validators if `parse` accepts its body (it throws otherwise), and forgets them if not.
	 * A 304 changes nothing.
	 */
	remember(raw: RawResponse, parse: () => unknown): void {
		if (raw.status === 304) return;
		this.#etag = null;
		this.#lastModified = null;
		if (!raw.etag && !raw.lastModified) return;
		try {
			parse();
		} catch {
			return;
		}
		this.#etag = raw.etag ?? null;
		this.#lastModified = raw.lastModified ?? null;
	}
}
