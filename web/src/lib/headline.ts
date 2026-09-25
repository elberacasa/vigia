/**
 * The "Ahora" line: what is happening right now, in one sentence, built by fixed rules from the computed panels.
 * No model writes it; each clause links to the panel that holds its source and age. Anomalies come first; when
 * nothing is anomalous it says so.
 *
 * This is the ONLY place that builds it: the page's line, the share cards, the plain-text share, the clean view and
 * the terminal report (/ahora.txt) all call `currentClauses`, which gates every clause, and every sub-clause, on the
 * freshness of its own feeds (review 3, H6: three copies of the clause→feed map had drifted apart).
 */
import { ago, clock, type Lang, num, pct } from "./format.ts";
import { groupFreshness, type HealthMap, isLive } from "./fresh.ts";

export interface Clause {
	text: string;
	href: string;
	tone: "alert" | "warn" | "normal";
	/** The feeds behind this clause; its freshness is theirs. */
	feeds: readonly string[];
}

/** A clause with its freshness: `stale` when none of its feeds is live, `lastAt` the newest good fetch among them. */
export interface CurrentClause extends Clause {
	stale: boolean;
	lastAt: number | null;
}

/** The minimal shapes this needs from each panel (structural, so the full view types fit). */
export interface HeadlineInput {
	connectivity?: {
		states: { id: string; name: string; level: string; kind: string }[];
		summary: { allClear: boolean };
	};
	nightlights?: {
		states: { name: string; pctChange: number | null; comparable: boolean }[];
	};
	money?: {
		official: { usd: { current: { vesPerUnit: number } | null } };
		yadio: { figure: { vesPerUsd: number; gap: { pct: number } | null } | null };
	};
	quakes?: {
		counts: { day: number };
		items: { at: number; maxMag: number; placeEs: string; zone: string; feltSize: boolean }[];
	};
	hazards?: { storms: { threats: number; active: { name: string; threat: boolean }[] } };
	weather?: { notable: { rule: string; when: string }[] };
	fires?: { venezuela: { last24h: number; persistent24h: number } };
	incidents?: {
		incidents: {
			title: { es: string; en: string };
			status: string;
			reportsOnly: boolean;
			families: readonly string[];
			lastEvidenceAt: number;
			stateName?: string | null;
		}[];
		/** Without new evidence for this long, an incident has ended (the server's RULES.activeMs). */
		activeMs?: number;
	};
}

/** Whether a feed may speak now: live, or unknown (no health yet, so the first paint is not blank). */
type Speaks = (feed: string) => boolean;

function build(p: HeadlineInput, now: number, lang: Lang, speaks: Speaks): Clause[] {
	const es = lang === "es";
	const out: Clause[] = [];

	// Active corroborated incidents come first: they are the day's clearest signal, and an incident can stay active
	// (RULES.activeMs without new evidence) after the live connectivity reading is back to normal. The families are
	// named (press is one family of reports, not a measurement); the count is only said of measurements. An incident
	// whose last evidence is older than an hour says since when nothing new arrived, and one past the active window
	// (the panel itself may be late) is not said at all.
	const activeMs = p.incidents?.activeMs ?? DEFAULT_ACTIVE_MS;
	const incidents = (p.incidents?.incidents ?? []).filter(
		(i) => i.status === "active" && !i.reportsOnly && now - i.lastEvidenceAt < activeMs,
	);
	for (const i of incidents.slice(0, 2)) out.push(incidentClause(i, now, lang));
	// A state already named by an incident above is not repeated as a plain signal drop.
	const named = new Set(incidents.slice(0, 2).map((i) => i.stateName ?? ""));
	const states = (p.connectivity?.states.filter((s) => s.kind === "state") ?? []).filter(
		(s) => !named.has(s.name),
	);
	const severe = states.filter((s) => s.level === "severe").map((s) => s.name);
	const drops = states.filter((s) => s.level === "drop").map((s) => s.name);
	if (severe.length) {
		out.push({
			text: es
				? `Caída fuerte de internet en ${list(severe, es)}`
				: `Severe internet drop in ${list(severe, es)}`,
			href: "#conectividad",
			tone: "alert",
			feeds: FEEDS.internet,
		});
	}
	if (drops.length) {
		out.push({
			text: es ? `Caída de señal en ${list(drops, es)}` : `Signal drop in ${list(drops, es)}`,
			href: "#conectividad",
			tone: "warn",
			feeds: FEEDS.internet,
		});
	}

	// Night lights: only clear-sky comparisons, and only a real fall (≥ 30 %).
	const dark = (p.nightlights?.states ?? [])
		.filter((s) => s.comparable && s.pctChange !== null && s.pctChange <= -30)
		.map((s) => s.name);
	if (dark.length) {
		out.push({
			text: es ? `Menos luz nocturna en ${list(dark, es)}` : `Less night light in ${list(dark, es)}`,
			href: "#luces",
			tone: "warn",
			feeds: FEEDS.lights,
		});
	}

	const threats = p.hazards?.storms.active.filter((s) => s.threat).map((s) => s.name) ?? [];
	if (threats.length) {
		out.push({
			text: es
				? `Ciclón cerca de Venezuela: ${list(threats, es)}`
				: `Cyclone near Venezuela: ${list(threats, es)}`,
			href: "#alertas",
			tone: "alert",
			feeds: FEEDS.storms,
		});
	}

	const felt = (p.quakes?.items ?? [])
		.filter((q) => q.zone !== "far" && q.feltSize && now - q.at < 24 * 3_600_000)
		.sort((a, b) => b.maxMag - a.maxMag)[0];
	if (felt) {
		out.push({
			text: es
				? `Sismo M${num(felt.maxMag, 1, "es")} ${felt.placeEs}`
				: `M${num(felt.maxMag, 1, "en")} quake ${felt.placeEs}`,
			href: "#sismos",
			tone: felt.maxMag >= 5 ? "alert" : "warn",
			feeds: FEEDS.quakes,
		});
	}

	const storms = p.weather?.notable.filter((n) => n.rule === "storm") ?? [];
	if (storms.length >= 3) {
		out.push({
			text: es
				? `Tormentas previstas en ${storms.length} capitales`
				: `Storms forecast in ${storms.length} capitals`,
			href: "#clima",
			tone: "normal",
			feeds: FEEDS.weather,
		});
	}

	// The official rate is the clause; the Yadio gap is a sub-clause with its own feed, left out when Yadio is late
	// (a stale gap printed next to a current rate reads as current).
	const usd = p.money?.official.usd.current;
	const y = p.money?.yadio.figure;
	if (usd) {
		const gap = y?.gap && FEEDS.yadio.some(speaks) ? y.gap : null;
		out.push({
			text: es
				? `Dólar BCV ${num(usd.vesPerUnit, 2, "es")} Bs${gap ? `, Yadio ${pct(gap.pct, 1, "es")}` : ""}`
				: `BCV dollar Bs ${num(usd.vesPerUnit, 2, "en")}${gap ? `, Yadio ${pct(gap.pct, 1, "en")}` : ""}`,
			href: "#dinero",
			tone: "normal",
			feeds: gap ? [...FEEDS.bcv, ...FEEDS.yadio] : FEEDS.bcv,
		});
	}

	// Never next to an active corroborated incident: "Posible apagón en Zulia · Internet sin caídas" contradicts itself
	// (review 4, H4), even when IODA has recovered while the incident is still open.
	if (p.connectivity?.summary.allClear && !incidents.length) {
		out.unshift({
			text: es ? "Internet sin caídas por estado" : "No internet drops by state",
			href: "#conectividad",
			tone: "normal",
			feeds: FEEDS.internet,
		});
	}
	return out;
}

type IncidentInput = NonNullable<HeadlineInput["incidents"]>["incidents"][number];

/** The server's RULES.activeMs, for panels computed before `activeMs` was sent. */
const DEFAULT_ACTIVE_MS = 3 * 3_600_000;
/** Past this, "última señal hace X" reads as ongoing: the clause says since when nothing new arrived instead. */
export const INCIDENT_QUIET_MS = 3_600_000;

/** Short family names for one line, in the incidents panel's order; press last. */
const FAMILY_NAMES: Record<string, { es: string; en: string; feeds: readonly string[]; measured: boolean }> =
	{
		ioda: { es: "IODA", en: "IODA", feeds: ["ioda-states", "ioda-events"], measured: true },
		"ripe-atlas": { es: "RIPE Atlas", en: "RIPE Atlas", feeds: ["ripe-atlas-probes"], measured: true },
		viirs: {
			es: "luces nocturnas de NASA",
			en: "NASA night lights",
			feeds: ["gibs-nightlights"],
			measured: true,
		},
		usgs: { es: "USGS", en: "USGS", feeds: ["usgs-quakes"], measured: true },
		funvisis: { es: "FUNVISIS", en: "FUNVISIS", feeds: ["funvisis-quakes"], measured: true },
		gdacs: { es: "GDACS", en: "GDACS", feeds: ["gdacs-events"], measured: true },
		prensa: { es: "prensa", en: "press", feeds: [], measured: false },
	};
const FAMILY_ORDER = Object.keys(FAMILY_NAMES);

/**
 * "Posible apagón en Zulia (IODA y prensa, última señal hace 25 min)"; with measurements only, "(2 mediciones
 * independientes: IODA y RIPE Atlas, …)"; quiet for over an hour, "(…, sin señal nueva desde las 14:10, hace 2 h)".
 * Its feeds are the measured families' feeds, so it ages like every other clause.
 */
function incidentClause(i: IncidentInput, now: number, lang: Lang): Clause {
	const es = lang === "es";
	const fams = FAMILY_ORDER.filter((f) => i.families.includes(f));
	const unknown = [...new Set(i.families)].filter((f) => !FAMILY_NAMES[f]);
	const names = [...fams.map((f) => FAMILY_NAMES[f]?.[lang] ?? f), ...unknown];
	const measured = fams.filter((f) => FAMILY_NAMES[f]?.measured).length + unknown.length;
	const who =
		measured === names.length && measured >= 2
			? es
				? `${measured} mediciones independientes: ${list(names, es)}`
				: `${measured} independent measurements: ${list(names, es)}`
			: list(names, es);
	const quiet = now - i.lastEvidenceAt;
	const when =
		quiet > INCIDENT_QUIET_MS
			? es
				? `sin señal nueva desde las ${clock(i.lastEvidenceAt, "es")}, ${ago(quiet, "es")}`
				: `no new signal since ${clock(i.lastEvidenceAt, "en")}, ${ago(quiet, "en")}`
			: es
				? `última señal ${ago(quiet, "es")}`
				: `last signal ${ago(quiet, "en")}`;
	return {
		text: `${es ? i.title.es : i.title.en} (${who}, ${when})`,
		href: "#incidentes",
		tone: "alert",
		feeds: [...new Set(fams.flatMap((f) => FAMILY_NAMES[f]?.feeds ?? []))],
	};
}

/** The feeds behind each kind of clause (server adapter ids). */
const FEEDS = {
	internet: ["ioda-states"],
	lights: ["gibs-nightlights"],
	storms: ["nhc-storms", "gdacs-events"],
	quakes: ["usgs-quakes", "funvisis-quakes"],
	weather: ["open-meteo-weather"],
	bcv: ["bcv-official", "bcv-api"],
	yadio: ["yadio"],
} as const satisfies Record<string, readonly string[]>;

/**
 * The Ahora clauses as they may be said now. A clause whose feeds are all late: an all-normal one is dropped (silence
 * is not news, and a stale "sin caídas" is a false all-clear); an anomaly stays, marked stale with the age of its last
 * good data. Sub-clauses (the Yadio gap) are gated on their own feed. At most five clauses.
 */
export function currentClauses(
	p: HeadlineInput,
	health: HealthMap,
	now: number,
	lang: Lang,
): CurrentClause[] {
	// A feed with no health entry yet (before /api/health loads) is unknown, not live (review 4 L7): it does not
	// speak, and an all-normal clause none of whose feeds is known yet is not said ("sin caídas" is a claim).
	const speaks: Speaks = (feed) => isLive(health.get(feed)?.state);
	const known = (c: Clause) => c.feeds.some((feed) => health.has(feed));
	return build(p, now, lang, speaks)
		.map((c) => ({ ...c, ...groupFreshness(c.feeds, health) }))
		.filter((c) => !(c.stale && c.tone === "normal") && (c.tone !== "normal" || known(c)))
		.slice(0, 5);
}

/** A clause as plain text, with "(dato de hace 3 h)" when it is stale: for share cards, WhatsApp text and terminals. */
export function clauseText(c: CurrentClause, now: number, lang: Lang): string {
	if (!c.stale) return c.text;
	const es = lang === "es";
	return c.lastAt
		? `${c.text} (${es ? "dato de" : "data from"} ${ago(now - c.lastAt, lang)})`
		: `${c.text} (${es ? "sin actualizar" : "not updated"})`;
}

/** The feeds behind a set of clauses, once each (a share card's footer names them all). */
export function clauseFeeds(clauses: readonly Clause[]): string[] {
	return [...new Set(clauses.flatMap((c) => c.feeds))];
}

function list(names: string[], es: boolean): string {
	if (names.length <= 3) {
		if (names.length === 1) return names[0] ?? "";
		return `${names.slice(0, -1).join(", ")} ${es ? "y" : "and"} ${names.at(-1)}`;
	}
	return es
		? `${names.slice(0, 2).join(", ")} y ${names.length - 2} más`
		: `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}
