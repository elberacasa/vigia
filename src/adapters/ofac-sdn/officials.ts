import type { OfficeHolder } from "../wikidata-officials/sparql.ts";

/**
 * Who on OFAC's Venezuela lists may be named: public officials acting in office, as the sanctions list
 * or Wikidata record them (docs/ETHICS.md). Everyone else is only counted. Two deterministic rules, either suffices:
 *
 * 1. **OFAC's own title** (the SDN "Title" field) names a Venezuelan public office: a ministry, a governorship, the
 *    courts, the electoral council, the armed forces, the police, the state oil company… (`isPublicOfficeTitle`).
 *    Measured 2026-09-28: 51 of the 190 individuals on the Venezuela programmes carry such a title.
 * 2. **Wikidata** lists the person as a holder (ever) of a Venezuelan public office, matched on the name strictly
 *    enough to be unambiguous (`officialMatches`): the holder's label, accents and particles aside, must have at
 *    least two words, begin with OFAC's first given name, end with one of OFAC's surnames, and use no word OFAC's
 *    name lacks; and the match must be one-to-one (one holder for the individual, one individual for the holder).
 *    "José Gutiérrez" matching two sanctioned José Gutiérrez is dropped, not guessed.
 *
 * Nothing about a person who is not named is stored: no name, no OFAC id, no alias, date of birth or document.
 */

const PUBLIC_OFFICE = new RegExp(
	[
		"\\bVenezuela",
		"\\bBolivarian\\b",
		"\\bMinist(er|ry|ro)\\b",
		"\\bMinster\\b",
		"\\bVice Minister\\b",
		"\\bGovernor\\b",
		"\\bMayor\\b",
		"\\bState\\b",
		"\\bNational (Armed|Guard|Police|Assembly|Electoral|Bank|Treasury|Constituent|Superintendent|Center)",
		"\\bSupreme Court\\b",
		"\\bMagistrate\\b",
		"\\bProsecutor\\b",
		"\\bAttorney General\\b",
		"\\bOmbudsman\\b",
		"\\bComptroller\\b",
		"\\bAmbassador\\b",
		"\\b(Major|Brigadier|Division|Lieutenant) General\\b",
		"\\bGeneral Commander\\b",
		"\\bCommander\\b",
		"\\bAdmiral\\b",
		"\\bPDVSA\\b",
		"\\bSEBIN\\b",
		"\\bDGCIM\\b",
		"\\bFANB\\b",
		"\\bCVG\\b",
	].join("|"),
	"i",
);

/** OFAC's Title field names a public office (rule 1). Empty or "-0-" is not a title. */
export function isPublicOfficeTitle(title: string | null | undefined): boolean {
	const t = (title ?? "").trim();
	return t !== "" && t !== "-0-" && PUBLIC_OFFICE.test(t);
}

const PARTICLES = new Set(["de", "del", "la", "las", "los", "y", "da", "do", "dos", "van", "von"]);

/** Lower case, accents folded, particles dropped: "RODRÍGUEZ de la Paz" → ["rodriguez", "paz"]. */
export function nameWords(text: string): string[] {
	return text
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z\s-]/g, " ")
		.split(/[\s-]+/)
		.filter((w) => w.length > 1 && !PARTICLES.has(w));
}

/** OFAC writes individuals as "SURNAMES, Given names". */
export function ofacNameParts(name: string): { surnames: string[]; given: string[] } | null {
	const comma = name.indexOf(",");
	if (comma < 0) return null;
	const surnames = nameWords(name.slice(0, comma));
	const given = nameWords(name.slice(comma + 1));
	return surnames.length > 0 && given.length > 0 ? { surnames, given } : null;
}

/** Whether a Wikidata label can be this OFAC individual (rule 2, before the one-to-one check). */
export function labelMatches(label: string, ofacName: string): boolean {
	const parts = ofacNameParts(ofacName);
	const words = nameWords(label);
	if (!parts || words.length < 2) return false;
	const all = new Set([...parts.surnames, ...parts.given]);
	return (
		words[0] === parts.given[0] &&
		parts.surnames.includes(words.at(-1) ?? "") &&
		words.every((w) => all.has(w))
	);
}

/**
 * For each OFAC individual name, the single Wikidata office holder it matches one-to-one, if any. `names` must be
 * every individual being judged together (all of a run's Venezuela-programme individuals), so the one-to-one check
 * sees them all.
 */
export function officialMatches(
	names: readonly string[],
	holders: readonly OfficeHolder[],
): Map<string, OfficeHolder> {
	const byName = new Map<string, OfficeHolder[]>();
	const byHolder = new Map<string, Set<string>>();
	for (const name of new Set(names)) {
		for (const h of holders) {
			if (!labelMatches(h.label, name)) continue;
			byName.set(name, [...(byName.get(name) ?? []), h]);
			byHolder.set(h.qid, (byHolder.get(h.qid) ?? new Set()).add(name));
		}
	}
	const out = new Map<string, OfficeHolder>();
	for (const [name, candidates] of byName) {
		const only = candidates.length === 1 ? candidates[0] : undefined;
		if (only && byHolder.get(only.qid)?.size === 1) out.set(name, only);
	}
	return out;
}
