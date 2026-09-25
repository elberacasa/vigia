/**
 * Styles that belong to a chunk loaded on demand (a panel body, a page, a sheet) travel inside that chunk and are
 * inserted once, when it first runs; the first load carries only the styles of the first screen. Inserted after
 * the main stylesheet, so a rule here wins over an equally specific one there (checked by a computed-style diff of
 * the whole wall when the split was made).
 */
const added = new Set<string>();

export function addStyles(css: string): void {
	if (added.has(css) || typeof document === "undefined") return;
	added.add(css);
	const style = document.createElement("style");
	style.textContent = css;
	document.head.append(style);
}
