import type { Adapter, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { caracasDateToMs, caracasDay } from "../../formats/time.ts";
import { stripHtml } from "../../news/text.ts";
import { type ActCategory, classifyAct, stripIds } from "./redact.ts";

/**
 * Gaceta Oficial de la República Bolivariana de Venezuela: the new issues (number, ordinary or extraordinary, date,
 * the PDF) and their table of contents ("sumario": the issuing body and the title of each act), from the official
 * index the Imprenta Nacional publishes at www.gacetaoficial.gob.ve.
 *
 * Verified 2026-09-24 from outside Venezuela: plain HTTP only (HTTPS: TLS EOF), robots.txt `Disallow:` empty
 * (everything allowed), no feed and no documented API. Two public pages are used, as a visitor would:
 * - `/gacetas/filtro-avanzado?fecha_desde=…&fecha_hasta=…`: the issues in a date range, one table row each
 *   (number "43.457", ORDINARIA / EXTRAORDINARIA, "11/09/2026", pages, status, link). ~16 KB, 0.3–0.6 s. With only
 *   `fecha_desde` the site returns that single day; both bounds give the range.
 * - `/gacetas/<número>`: the issue's header row, the "Sumarios" table (Órgano, Ente adscrito, Título, pages) and the
 *   PDF (`<object data=…/storage/2026/43457-2026-09-11-ORDINARIA.pdf>`). ~17 KB each.
 * The index lags the printed Gaceta: on 2026-09-24 the newest issue listed was N° 7.074 Extraordinaria of 15/09
 * (the reform of the TSJ organic law), so the freshness budget is generous and the panel says "según el índice".
 * Some older extraordinary issues have no sumario rows (e.g. N° 6.691 of 2022): they are kept with `actsListed`
 * false and the panel points to the PDF.
 *
 * Privacy (code review 4, H1): sumarios name people (appointments, pensions, delegations), often
 * private ones. A title is kept word for word only when `classifyAct` (redact.ts) finds an act form that names no
 * one and nothing that points at a person; every other act keeps only its category ("designación", "jubilación o
 * pensión"…), which the panel counts. Identity numbers are stripped from every stored string. This happens in
 * `parseIssue`, before anything is stored, and `purgeStoredGaceta` re-applies it to rows stored by older versions.
 * The rows are not handed out raw (`raw: false`): only the panel's derived view is served. Raw pages carry the
 * names, so recorded fixtures stay internal (scripts/export/policy.ts) and a synthetic test covers the parser.
 *
 * Licence: the Gaceta is the official record of the State's acts; Venezuela's copyright law does not protect
 * official texts of a legislative, administrative or judicial nature (Ley sobre el Derecho de Autor, art. 11).
 * Vigía keeps only titles, dates and links, and always links to the official page and PDF.
 */

export const GACETA_HOME = "http://www.gacetaoficial.gob.ve/";
const BASE = "http://www.gacetaoficial.gob.ve";
/** Days of issues listed per run: covers the index's ~10-day lag plus a month of history. */
export const LIST_DAYS = 35;
/** Issue pages fetched per run at most (newest first); older ones already stored are skipped via `ctx.seen`. */
export const MAX_DETAILS = 12;
/** One request every 3 s: a person clicking through the index goes faster. */
const HOST_GAP_MS = 3_000;

export const GACETA_LICENCE: Licence = {
	id: "gaceta-oficial-ve",
	name: "Texto oficial (sin protección de derecho de autor, Ley sobre el Derecho de Autor, art. 11)",
	url: GACETA_HOME,
	attribution: "Gaceta Oficial de la República Bolivariana de Venezuela (Imprenta Nacional)",
	commercial: true,
	// Public domain, but every title that is not listed was reduced to a category: the stored rows are served only
	// through the panel (no raw series, no /api/v1 rows), so a future classifier bug cannot leak through an export.
	raw: false,
};

export type GacetaAct = {
	/** Issuing body as listed ("MINISTERIO DEL PODER POPULAR PARA LA DEFENSA"). */
	organ: string;
	/** The attached entity, when listed ("SERVICIO NACIONAL DE CONTRATACIONES"). */
	entity: string | null;
	/** The act's title word for word, only when its form names no one (`classifyAct`); otherwise null. */
	title: string | null;
	/** First word of the title when it names an instrument: "Decreto", "Resolución", "Ley"… */
	instrument: string | null;
	/** Why the title was not kept ("designacion", "jubilacion"…); null when it was. */
	withheld: ActCategory | null;
};

export type GacetaIssue = {
	number: number;
	kind: "ordinaria" | "extraordinaria";
	/** Publication date, "YYYY-MM-DD" (Caracas). */
	date: string;
	pdfUrl: string | null;
	status: string;
	/** Whether the official index lists this issue's contents (some extraordinary issues have none). */
	actsListed: boolean;
	acts: GacetaAct[];
};

/** Issue numbers are separate series: ordinary 43.xxx and extraordinary 7.xxx. */
export function issueSeries(kind: GacetaIssue["kind"], n: number): string {
	return `gaceta:${kind === "ordinaria" ? "o" : "e"}:${n}`;
}

export function issueUrl(n: number): string {
	return `${BASE}/gacetas/${n}`;
}

export function listUrl(now: number): string {
	const from = caracasDay(now - LIST_DAYS * 86_400_000);
	const to = caracasDay(now + 86_400_000);
	return `${BASE}/gacetas/filtro-avanzado?fecha_desde=${from}&fecha_hasta=${to}`;
}

// ---------------------------------------------------------------------------------------------------------
// Parsing (linear scans with indexOf; no backtracking regexes over the page)

/** The `<tr>` blocks inside the first `<tbody>` after `marker` (or the first `<tbody>` when no marker). */
export function tableRows(html: string, marker?: string): string[][] {
	let from = 0;
	if (marker) {
		from = html.indexOf(marker);
		if (from === -1) return [];
	}
	const start = html.indexOf("<tbody", from);
	if (start === -1) return [];
	const end = html.indexOf("</tbody>", start);
	const body = html.slice(start, end === -1 ? html.length : end);
	const rows: string[][] = [];
	for (const chunk of body.split(/<tr[\s>]/i).slice(1)) {
		const cells: string[] = [];
		let i = 0;
		for (;;) {
			const open = chunk.indexOf("<td", i);
			if (open === -1) break;
			const gt = chunk.indexOf(">", open);
			if (gt === -1) break;
			const close = chunk.indexOf("</td>", gt);
			// The cell's inner HTML; its text is read with stripHtml.
			cells.push(chunk.slice(gt + 1, close === -1 ? chunk.length : close));
			if (close === -1) break;
			i = close + 5;
		}
		if (cells.length) rows.push(cells);
	}
	return rows;
}

const text = (cell: string | undefined) => stripHtml(cell ?? "");

/** "43.457" → 43457. */
function issueNumber(s: string): number | null {
	const t = s.trim();
	if (!/^\d{1,3}(\.\d{3})*$/.test(t)) return null;
	const n = Number(t.replaceAll(".", ""));
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** "11/09/2026" → "2026-09-11" when it is a real date. */
function dmyToIso(s: string): string | null {
	const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
	if (!m) return null;
	const iso = `${m[3]}-${m[2]}-${m[1]}`;
	return caracasDateToMs(iso) === null ? null : iso;
}

function kindOf(s: string): GacetaIssue["kind"] | null {
	const t = s.trim().toUpperCase();
	return t === "ORDINARIA" ? "ordinaria" : t === "EXTRAORDINARIA" ? "extraordinaria" : null;
}

export type ListedIssue = { number: number; kind: GacetaIssue["kind"]; date: string; status: string };

/** The rows of the range listing; malformed rows are skipped. */
export function parseList(html: string): { issues: ListedIssue[]; invalid: number } {
	if (!html.includes("Resultados de Gacetas")) throw new SchemaError("Gaceta: no es la página de resultados");
	const issues: ListedIssue[] = [];
	let invalid = 0;
	for (const cells of tableRows(html, "Resultados de Gacetas")) {
		const number = issueNumber(text(cells[0]));
		const kind = kindOf(text(cells[1]));
		const date = dmyToIso(text(cells[3]));
		if (number === null || kind === null || date === null) {
			// "No se encontraron Gacetas" is a single colspan row, not an error.
			if (!/No se encontraron/i.test(text(cells[0]))) invalid++;
			continue;
		}
		issues.push({ number, kind, date, status: text(cells[6]) || "?" });
	}
	return { issues, invalid };
}

const INSTRUMENTS = [
	"Decreto",
	"Ley",
	"Resolución",
	"Providencia",
	"Acuerdo",
	"Aviso",
	"Sentencia",
	"Reglamento",
	"Convenio",
	"Oficio",
	"Circular",
	"Acto",
	"Resolución Conjunta",
];

function instrumentOf(title: string): string | null {
	const first = title.split(/\s+/, 2).join(" ");
	if (first.startsWith("Resolución Conjunta")) return "Resolución Conjunta";
	const w = title.split(/\s+/, 1)[0] ?? "";
	return INSTRUMENTS.includes(w) ? w : null;
}

/** An issue page: header row, sumario rows, PDF link. */
export function parseIssue(html: string): GacetaIssue {
	if (!html.includes("Detalles de la Gaceta")) throw new SchemaError("Gaceta: no es la página de un número");
	const head = tableRows(html, "Número de Gaceta")[0];
	const number = issueNumber(text(head?.[0]));
	const kind = kindOf(text(head?.[1]));
	const date = dmyToIso(text(head?.[3]));
	if (number === null || kind === null || date === null)
		throw new SchemaError("Gaceta: cabecera del número ilegible");
	const hasTable = html.includes('id="sumarios-table"');
	const acts: GacetaAct[] = [];
	if (hasTable) {
		for (const cells of tableRows(html, 'id="sumarios-table"')) {
			const organ = stripIds(text(cells[0])).text;
			const raw = text(cells[2]);
			if (!organ || !raw) continue;
			const act = classifyAct(raw);
			const entity = stripIds(text(cells[1])).text;
			acts.push({
				organ,
				entity: entity || null,
				title: act.title,
				instrument: instrumentOf(raw),
				withheld: act.category,
			});
		}
	}
	const pdfAt = html.indexOf("/storage/");
	let pdfUrl: string | null = null;
	if (pdfAt !== -1) {
		const end = html.indexOf(".pdf", pdfAt);
		const path = end === -1 ? "" : html.slice(pdfAt, end + 4);
		if (/^\/storage\/[\w./-]+\.pdf$/.test(path)) pdfUrl = `${BASE}${path}`;
	}
	const statusCell = head?.[6] ?? "";
	return {
		number,
		kind,
		date,
		pdfUrl,
		status: text(statusCell) || "?",
		actsListed: acts.length > 0,
		acts,
	};
}

export const gacetaOficial: Adapter<GacetaIssue> = {
	id: "gaceta-oficial",
	layer: "society",
	name: {
		es: "Gaceta Oficial: números nuevos y su sumario",
		en: "Official Gazette: new issues and contents",
	},
	provider: "Imprenta Nacional (Gaceta Oficial)",
	homepage: GACETA_HOME,
	licence: GACETA_LICENCE,
	keys: [],
	// Several issues a day at most, and the index lags ~10 days: every 6 h is plenty (9–13 requests a run).
	intervalMs: 6 * 3_600_000,
	// Fetch: 4 missed runs. Data: the index went 9 days without a new issue on 2026-09-24 (15/09 → 24/09), so a
	// silent index is only called stale after 21 days.
	freshness: { fetchMs: 24 * 3_600_000, dataMs: 21 * 86_400_000 },
	async fetch(ctx) {
		const opts = { hostGapMs: HOST_GAP_MS, timeoutMs: 30_000, maxBytes: 2_000_000, signal: ctx.signal };
		const list = await ctx.http.request(listUrl(ctx.now()), opts);
		const { issues } = parseList(list.body);
		const wanted = [...issues]
			.sort((a, b) => b.date.localeCompare(a.date) || b.number - a.number)
			.filter((i) => {
				const at = caracasDateToMs(i.date);
				return at === null || !ctx.seen?.(issueSeries(i.kind, i.number), at);
			})
			.slice(0, MAX_DETAILS);
		const out: RawResponse[] = [list];
		for (const i of wanted) {
			try {
				out.push(await ctx.http.request(issueUrl(i.number), opts));
			} catch {
				// One issue page failing is not the run failing: it is fetched again next time (not seen yet).
			}
		}
		return out;
	},
	normalise(raws) {
		const list = raws.find((r) => r.url.includes("/filtro-avanzado"));
		if (!list) throw new SchemaError("Gaceta: falta el listado");
		const listed = parseList(list.body);
		const obs: Observation<GacetaIssue>[] = [];
		for (const r of raws) {
			if (r === list || r.status !== 200) continue;
			let issue: GacetaIssue;
			try {
				issue = parseIssue(r.body);
			} catch {
				continue; // one unreadable issue page is skipped; the listing still validated the run
			}
			const at = caracasDateToMs(issue.date);
			if (at === null || at > r.fetchedAt + 86_400_000) continue;
			obs.push({
				source: "gaceta-oficial",
				series: issueSeries(issue.kind, issue.number),
				sourceUrl: issueUrl(issue.number),
				fetchedAt: r.fetchedAt,
				observedAt: at,
				licence: GACETA_LICENCE.id,
				value: issue,
				confidence: 1,
				basis: "official",
			});
		}
		if (listed.issues.length === 0 && listed.invalid > 0) throw new SchemaError("Gaceta: listado ilegible");
		return obs;
	},
};
