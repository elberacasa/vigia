import { type CzibValue, EASA_LICENCE, LIST_URL } from "../adapters/easa-czib/index.ts";
import {
	FAA_LICENCE,
	type FaaItem,
	type FaaPage,
	type FaaSection,
	type FaaValue,
	PAGE_URL,
} from "../adapters/faa-prohibitions/index.ts";
import type { Store } from "../core/store.ts";
import type { Panel } from "../server/panels.ts";

/**
 * Airspace: what the two regulators that publish machine-readable advisories say about flying over Venezuela
 * (the Maiquetía FIR, SVZM) and its neighbours. Official notices only, as published; no aircraft are tracked.
 *
 * - EASA conflict zone bulletins (CZIB): any bulletin naming Venezuela, active or withdrawn (history matters: one
 *   was in force from 2026-01-03 to 2026-02-16).
 * - FAA "Prohibitions, Restrictions and Notices": a Venezuela section or any listed document naming Venezuela,
 *   SVZM or Maiquetía; and the sections of nearby countries (a fixed list, below).
 *
 * Status rule: "advisory" when an active EASA bulletin names Venezuela or the FAA page has a Venezuela section or
 * mention; "none" when both sources were read and neither does; "unknown" when either has never been read.
 * Not covered: individual NOTAMs (the FAA NOTAM API needs an account) and airline suspensions (no official feed).
 */

/** FAA sections shown as "nearby": Venezuela's neighbours and the Caribbean / eastern Pacific notices around them. */
export const NEARBY = [
	"Colombia",
	"Panama",
	"Ecuador",
	"Central America",
	"Haiti",
	"Cuba",
	"Bahamas",
] as const;

export type CzibRow = {
	nid: string;
	number: string | null;
	name: string;
	status: "active" | "withdrawn";
	issuedDate: string;
	validUntil: string | null;
	updatedAt: number | null;
	url: string;
};

export type FaaSectionRow = {
	country: string;
	items: FaaItem[];
	/** Document identifiers in the titles, e.g. "KICZ A0050/26", "SFAR 119". */
	codes: string[];
	url: string;
};

/** "KICZ NOTAM A0050/26 …" → "KICZ A0050/26"; "Special Federal Aviation Regulation (SFAR) 119 …" → "SFAR 119". */
export function codesOf(items: readonly FaaItem[]): string[] {
	const out: string[] = [];
	for (const i of items) {
		const kicz = /KICZ\s+(?:NOTAM\s+)?(A\d{4}\/\d{2})/i.exec(i.title);
		const sfar = /SFAR\s*\)?\s*(\d{2,3})/i.exec(i.title);
		const code = kicz ? `KICZ ${kicz[1]}` : sfar ? `SFAR ${sfar[1]}` : null;
		if (code && !out.includes(code)) out.push(code);
	}
	return out;
}

export type AirspaceView = {
	status: "advisory" | "none" | "unknown";
	easa: {
		venezuelaActive: CzibRow[];
		/** Withdrawn bulletins that named Venezuela, newest first. */
		venezuelaHistory: CzibRow[];
		activeWorldwide: number;
		checkedAt: number | null;
		url: string;
	};
	faa: {
		lastUpdated: string | null;
		venezuela: FaaSectionRow | null;
		mentions: (FaaItem & { section: string })[];
		nearby: FaaSectionRow[];
		checkedAt: number | null;
		url: string;
	};
	ruleEs: string;
	ruleEn: string;
	notCoveredEs: string;
	notCoveredEn: string;
	feeds: string[];
	attribution: string;
};

const czibRow = (v: CzibValue, url: string): CzibRow => ({
	nid: v.nid,
	number: v.number,
	name: v.name,
	status: v.status,
	issuedDate: v.issuedDate,
	validUntil: v.validUntil,
	updatedAt: v.updatedAt,
	url,
});

export function airspaceView(store: Store): AirspaceView {
	const czibs = store.latestPerSeries<CzibValue>("easa-czib", 0, 1_000);
	const easaChecked = store.lastSuccessAt("easa-czib");
	const ve = czibs.filter((o) => o.value.venezuela);
	const venezuelaActive = ve
		.filter((o) => o.value.status === "active")
		.map((o) => czibRow(o.value, o.sourceUrl))
		.sort((a, b) => b.issuedDate.localeCompare(a.issuedDate));
	const venezuelaHistory = ve
		.filter((o) => o.value.status === "withdrawn")
		.map((o) => czibRow(o.value, o.sourceUrl))
		.sort((a, b) => b.issuedDate.localeCompare(a.issuedDate));

	const pageObs = store.latest<FaaValue>("faa-prohibitions", "faa:page");
	const page = pageObs?.value.kind === "page" ? (pageObs.value as FaaPage) : null;
	const faaChecked = store.lastSuccessAt("faa-prohibitions");
	// Only the sections on the newest page: a section the FAA removed stays in history, not on screen.
	const current = new Set(page?.sections ?? []);
	const sections = store
		.latestPerSeries<FaaValue>("faa-prohibitions", 0, 1_000)
		.filter((o) => o.value.kind === "section" && current.has((o.value as FaaSection).country))
		.map((o) => ({ s: o.value as FaaSection, url: o.sourceUrl }));
	const row = ({ s, url }: { s: FaaSection; url: string }): FaaSectionRow => ({
		country: s.country,
		items: s.items,
		codes: codesOf(s.items),
		url,
	});
	const veSection = sections.find((x) => /venezuela/i.test(x.s.country));
	const nearby = NEARBY.flatMap((c) => {
		const hit = sections.find((x) => x.s.country === c);
		return hit ? [row(hit)] : [];
	});

	const faaSays = page ? page.venezuelaSection || page.venezuelaMentions.length > 0 : null;
	const easaSays = czibs.length ? venezuelaActive.length > 0 : null;
	const status =
		easaSays === true || faaSays === true
			? "advisory"
			: easaSays === false && faaSays === false
				? "none"
				: "unknown";

	return {
		status,
		easa: {
			venezuelaActive,
			venezuelaHistory,
			activeWorldwide: czibs.filter((o) => o.value.status === "active").length,
			checkedAt: easaChecked,
			url: LIST_URL,
		},
		faa: {
			lastUpdated: page?.lastUpdated ?? null,
			venezuela: veSection ? row(veSection) : null,
			mentions: page?.venezuelaMentions ?? [],
			nearby,
			checkedAt: faaChecked,
			url: PAGE_URL,
		},
		ruleEs:
			"«Con aviso» si EASA tiene un boletín activo que nombra a Venezuela, o si la página de la FAA tiene una sección de Venezuela o un documento que nombra a Venezuela, SVZM o Maiquetía.",
		ruleEn:
			"'Advisory' if EASA has an active bulletin naming Venezuela, or the FAA page has a Venezuela section or a document naming Venezuela, SVZM or Maiquetía.",
		notCoveredEs:
			"No incluye NOTAM individuales (la API de NOTAM de la FAA requiere cuenta) ni suspensiones de aerolíneas (no hay fuente oficial abierta). No se sigue ninguna aeronave.",
		notCoveredEn:
			"Does not include individual NOTAMs (the FAA NOTAM API needs an account) or airline suspensions (no open official source). No aircraft is tracked.",
		feeds: ["easa-czib", "faa-prohibitions"],
		attribution: `${EASA_LICENCE.attribution} · ${FAA_LICENCE.attribution}`,
	};
}

export const airspacePanel: Panel<AirspaceView> = {
	id: "airspace",
	sources: ["easa-czib", "faa-prohibitions"],
	compute: (store: Store) => airspaceView(store),
};
