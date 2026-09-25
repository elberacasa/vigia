/** Text normalisation shared by the tagger, topic rules and clustering. Deterministic and locale-free. */

/** Lowercase, strip accents (ñ kept distinct from n), unify punctuation to spaces. */
export function normalize(text: string): string {
	return text
		.toLowerCase()
		.replaceAll("ñ", "\u0000")
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replaceAll("\u0000", "ñ")
		.replace(/[^a-z0-9ñ]+/g, " ")
		.trim();
}

export function tokens(text: string): string[] {
	const n = normalize(text);
	return n ? n.split(" ") : [];
}

/** Spanish stopwords that carry no meaning for similarity. */
export const STOPWORDS = new Set(
	`a al algo ante antes como con contra cual cuando de del desde donde durante e el ella ellos en entre era es esa ese
	esta este esto estos fue fueron ha han hasta hay la las le les lo los mas me mi muy ni no nos o otra otro para pero
	por que quien se sea segun ser si sin sobre son su sus tambien tras tu un una uno unos y ya tras hoy ayer este
	sera seran fue tiene tienen dijo dice asi aun cada dos tres vez ser via tras`
		.split(/\s+/)
		.filter(Boolean),
);

/** Longest text we ever strip: summaries show 400 characters, titles far fewer. */
export const STRIP_MAX_CHARS = 20_000;

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };

function codePoint(n: number): string {
	return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
		? String.fromCodePoint(n)
		: " ";
}

/**
 * Strips HTML to plain text in one linear pass (no backtracking regexes: a hostile feed cannot stall the server),
 * skipping <script>/<style> contents and decoding the entities feeds actually use. Input is capped first.
 */
export function stripHtml(html: string): string {
	const src = html.length > STRIP_MAX_CHARS ? html.slice(0, STRIP_MAX_CHARS) : html;
	let out = "";
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		// A tag starts with a letter, "/", "!" or "?"; any other "<" is text ("inflación < 3 %").
		if (ch === "<" && /[a-zA-Z/!?]/.test(src[i + 1] ?? "")) {
			const close = src.indexOf(">", i + 1);
			if (close === -1) break; // an unclosed tag: drop the rest
			const tag = src.slice(i + 1, Math.min(close, i + 12)).toLowerCase();
			i = close + 1;
			const skip = tag.startsWith("script") ? "</script" : tag.startsWith("style") ? "</style" : null;
			if (skip) {
				const end = src.toLowerCase().indexOf(skip, i);
				if (end === -1) break;
				const endClose = src.indexOf(">", end);
				i = endClose === -1 ? src.length : endClose + 1;
			}
			out += " ";
			continue;
		}
		if (ch === "&") {
			const semi = src.indexOf(";", i + 1);
			if (semi !== -1 && semi - i <= 10) {
				const name = src.slice(i + 1, semi);
				let decoded: string | undefined;
				if (name.startsWith("#x") || name.startsWith("#X"))
					decoded = codePoint(Number.parseInt(name.slice(2), 16));
				else if (name.startsWith("#")) decoded = codePoint(Number(name.slice(1)));
				else decoded = ENTITIES[name];
				if (decoded !== undefined) {
					out += decoded;
					i = semi + 1;
					continue;
				}
			}
		}
		out += ch;
		i++;
	}
	return out.replace(/\s+/g, " ").trim();
}

/**
 * Removes a wire-style dateline from the start of a summary ("CARACAS.- …", "Caracas, 24 sep (EFE) …",
 * "MARACAIBO (Redacción) –"): it says where the reporter filed from, not where the story happened.
 */
export function stripDateline(text: string): string {
	return text
		.replace(/^\s*[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .]{2,30}\s*(\.-|\.–|–|—|-)\s*/, "")
		.replace(
			/^\s*[A-ZÁÉÍÓÚÑ][\wáéíóúñ .]{2,30},\s*\d{1,2}\s+(de\s+)?[a-záéíóú]{3,10}\.?(\s+de\s+\d{4})?\s*(\([^)]{1,30}\))?\s*[.:–—-]?\s*/,
			"",
		)
		.replace(/^\s*[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .]{2,30}\s*\([^)]{1,30}\)\s*[.:–—-]?\s*/, "");
}
