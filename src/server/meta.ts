/**
 * /api/meta, sized for a slow phone (review 4 M7): 303 feeds repeated 40 licence objects (75 KB of a 236 KB
 * body). Each distinct licence is sent once in `licences`, and a feed carries its key. The body has no clock in it,
 * so it only changes when the feeds do, and a strong ETag lets the browser revalidate for a 304 of no bytes.
 */

export interface PackedMeta<F> {
	readonly feeds: (Omit<F, "licence"> & { licence: string | null })[];
	readonly licences: Record<string, unknown>;
}

/** Replaces each feed's licence object with a key into one table; the same id with other text gets `id~2`… */
export function packLicences<F extends { licence: unknown }>(feeds: readonly F[]): PackedMeta<F> {
	const licences: Record<string, unknown> = {};
	const keyOf = new Map<string, string>();
	const packed = feeds.map((feed) => {
		const { licence, ...rest } = feed;
		if (licence === null || licence === undefined) return { ...rest, licence: null };
		const text = JSON.stringify(licence);
		let key = keyOf.get(text);
		if (key === undefined) {
			const id = typeof (licence as { id?: unknown }).id === "string" ? (licence as { id: string }).id : "l";
			key = id;
			for (let n = 2; key in licences; n++) key = `${id}~${n}`;
			licences[key] = licence;
			keyOf.set(text, key);
		}
		return { ...rest, licence: key };
	});
	return { feeds: packed, licences };
}

/** A strong validator for a body: the same bytes always give the same tag. */
export function strongEtag(body: string): string {
	return `"m-${Bun.hash(body).toString(36)}"`;
}

/**
 * Whether `If-None-Match` names this tag. The gzip representation carries the tag with `-gz` (see compress), and
 * a client revalidating that one is answered by the same check.
 */
export function etagMatches(header: string | null, etag: string): boolean {
	if (!header) return false;
	const bare = etag.replace(/"/g, "");
	return header
		.split(",")
		.map((t) => t.trim().replace(/^W\//, "").replace(/"/g, "").replace(/-gz$/, ""))
		.some((t) => t === bare || t === "*");
}
