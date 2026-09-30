/**
 * What of a news item Vigía may keep about private persons (docs/ETHICS.md, "People").
 *
 * - **Court notices are never kept.** Local papers print the courts' notices ("Edicto", "Cartel de notificación",
 *   "citación", "emplazamiento", "remate"): a private person's full name, identity number, address, a minor's
 *   case. The whole review of 29 Sept 2026 found 43 of them stored from 16 outlets and linked to places through a
 *   surname that is also a municipality. They are not news about events or places; they are dropped before storage.
 * - **Identity numbers are stripped** from every title and summary that is kept (the labelled forms: cédula, C.I.,
 *   RIF, pasaporte, a lettered V-/E- number), the same patterns the Gaceta rule uses.
 *
 * Everything is matched on folded text (no accents, lower case), so "EDICTO", "Édicto" and "edicto" are one word.
 */

import { stripLabelledIds } from "../adapters/gaceta-oficial/redact.ts";

function fold(s: string): string {
	return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** A title that opens as a court notice (after any leading punctuation or a section label). */
const NOTICE_TITLE =
	/^(?:[^\p{L}]*(?:clasificados?|avisos?|judiciales?|legales?)\s*[:|/-]\s*)*[^\p{L}]*(?:edictos?|carteles? de (?:notificacion|citacion|emplazamiento|intimacion|remate)|notificacion judicial|aviso judicial|citacion judicial)\b/u;
/**
 * Wording that makes a text a court notice wherever it appears. Deliberately narrow: news about a court ("el
 * tribunal notificó a la defensa…") stays; only the notices' own formulas count.
 */
const NOTICE_TEXT =
	/\b(?:cita y emplaza|(?:cartel|edicto) de (?:notificacion|citacion|emplazamiento|intimacion|remate)|unicos y universales herederos)\b/u;

/** A court notice: never stored, never linked. */
export function isCourtNotice(title: string, summary = ""): boolean {
	const t = fold(title);
	if (NOTICE_TITLE.test(t)) return true;
	return NOTICE_TEXT.test(`${t} ${fold(summary)}`);
}

/** A kept title or summary with every labelled identity number removed. */
export function redactNewsText(s: string): string {
	return stripLabelledIds(s).text;
}
