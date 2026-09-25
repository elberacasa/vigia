/**
 * Which characters of a formatted figure changed, aligned from the right (units under units), so "853,50" →
 * "855,66" rolls only the "3", "5" and "0" and "99,50" → "100,20" rolls every place that moved.
 */
export interface Glyph {
	/** The character now shown. */
	ch: string;
	/** The character that was in this place before, or "" when the figure grew. Null when unchanged. */
	was: string | null;
	/** Position among the changed characters, left to right (for the stagger). */
	order: number;
}

export function diffGlyphs(before: string, after: string): Glyph[] {
	const a = [...before];
	const b = [...after];
	const offset = a.length - b.length;
	let order = 0;
	return b.map((ch, i) => {
		const old = a[i + offset] ?? "";
		if (old === ch) return { ch, was: null, order: -1 };
		return { ch, was: old, order: order++ };
	});
}
