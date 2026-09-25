/**
 * The code blocks' markup, built on the server as one HTML string each (trusted build-time input: the repository's own
 * captures and source). One string instead of hundreds of elements keeps the page's DOM and its React payload small.
 */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const span = (cls: string, text: string) => `<span class="${cls}">${esc(text)}</span>`;

/** The terminal report: headings brighter, rule lines drawn as borders (the fonts have no box-drawing glyphs). */
export function terminalHtml(text: string): string {
	return text
		.split("\n")
		.map((line) => {
			if (/^─+$/.test(line)) return '<span class="term-rule" aria-hidden="true"></span>';
			const body = /^[A-ZÁÉÍÓÚÑ ]{4,}/.test(line) ? span("text-text", line) : esc(line);
			return `${body}\n`;
		})
		.join("");
}

/** JSON with keys, strings and numbers told apart. */
export function jsonHtml(raw: string): string {
	const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?|true|false|null)/g;
	let out = "";
	let last = 0;
	for (const m of raw.matchAll(re)) {
		const i = m.index ?? 0;
		out += esc(raw.slice(last, i));
		if (m[1]) out += span(m[2] ? "text-text" : "tok-s", m[1]) + (m[2] ?? "");
		else out += span("tok-t", m[0]);
		last = i + m[0].length;
	}
	return out + esc(raw.slice(last));
}

/** A tiny TypeScript highlighter for the contract snippets (keywords, types, strings, comments). */
export function tsHtml(code: string): string {
	const re =
		/(\/\*\*[\s\S]*?\*\/|\/\/[^\n]*)|("(?:[^"\\]|\\.)*")|\b(export|interface|readonly|extends|type)\b|\b(string|number|boolean|Promise|Json|Layer|Licence|FreshnessBudget|BlobPolicy|FetchContext|RawResponse|Observation|GeoPoint|Basis|V|true)\b/g;
	let out = "";
	let last = 0;
	for (const m of code.matchAll(re)) {
		const i = m.index ?? 0;
		out += esc(code.slice(last, i));
		out += span(m[1] ? "tok-c" : m[2] ? "tok-s" : m[3] ? "tok-k" : "tok-t", m[0]);
		last = i + m[0].length;
	}
	return out + esc(code.slice(last));
}
