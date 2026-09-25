/**
 * The one sanitiser for text printed on a terminal from anything Vigía did not write itself (an evidence file, a
 * feed's titles, the archive): `vigia verify`, `vigia status` and /ahora.txt all go through it.
 */

/**
 * Replaces with a space every character that can move the cursor, recolour, retitle or clear a terminal, or
 * reorder what is shown: C0 and C1 controls (so every escape sequence loses its ESC/CSI/OSC introducer), DEL,
 * bidirectional overrides and isolates (U+202A–202E, U+2066–2069, U+200E/200F, U+061C), and the Unicode line and
 * paragraph separators (U+2028, U+2029).
 */
export function clean(text: string): string {
	return text.replace(
		// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
		/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069\u2028\u2029]/g,
		" ",
	);
}
