/**
 * IPv4 prefix arithmetic for routing diffs: how much address space a set of prefixes covers, and how much one set
 * covers that another does not. Prefixes overlap (an ISP announces a /19 and /20s inside it), so space is counted
 * on the merged union, never by adding prefix sizes.
 */

export type Range = readonly [start: number, end: number];

/** "190.6.10.0/24" → [start, end) as unsigned integers; null when it is not a valid IPv4 prefix. */
export function parseV4(prefix: string): Range | null {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(prefix.trim());
	if (!m) return null;
	const octets = m.slice(1, 5).map(Number);
	const len = Number(m[5]);
	if (octets.some((o) => o > 255) || len > 32) return null;
	const [a = 0, b = 0, c = 0, d = 0] = octets;
	const ip = ((a * 256 + b) * 256 + c) * 256 + d;
	const size = 2 ** (32 - len);
	const start = Math.floor(ip / size) * size;
	return [start, start + size];
}

/** Sorted, merged, non-overlapping ranges. */
export function union(prefixes: Iterable<string>): Range[] {
	const ranges = [...prefixes]
		.map(parseV4)
		.filter((r): r is Range => r !== null)
		.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
	const out: [number, number][] = [];
	for (const [s, e] of ranges) {
		const last = out.at(-1);
		if (last && s <= last[1]) last[1] = Math.max(last[1], e);
		else out.push([s, e]);
	}
	return out;
}

export function size(ranges: readonly Range[]): number {
	return ranges.reduce((sum, [s, e]) => sum + (e - s), 0);
}

/** Addresses in `a` not in `b` (both merged unions). */
export function minusSize(a: readonly Range[], b: readonly Range[]): number {
	let total = 0;
	let j = 0;
	for (const [s0, e] of a) {
		let s = s0;
		while (j < b.length && (b[j]?.[1] ?? 0) <= s) j++;
		let k = j;
		while (s < e) {
			const r = b[k];
			if (!r || r[0] >= e) {
				total += e - s;
				break;
			}
			if (r[0] > s) total += r[0] - s;
			s = Math.max(s, r[1]);
			k++;
		}
	}
	return total;
}
