import { type Lang, num } from "./format.ts";

/**
 * The status bar's event ticker: discrete things that happened, taken from panel data the page already has (no
 * extra request). Each event carries the time it happened according to its source, and the source's name. The
 * ticker shows the latest few and moves only when a new one appears.
 *
 * Kinds: a quake in or near Venezuela; an IODA outage starting or ending; a BCV rate published ahead of its value
 * date (time = when Vigía first saw it); a GDACS alert other than a quake (quakes come from USGS/FUNVISIS) or any
 * orange/red one; a censorship change detected between two versions of a block list.
 */
export type TickerKind = "quake" | "outage" | "outage-end" | "rate" | "alert" | "block" | "unblock";

export interface TickerEvent {
	id: string;
	kind: TickerKind;
	at: number;
	/** Short line, e.g. "Sismo M3,6 · a 13 km al O de Irapa (Sucre)". */
	text: string;
	source: string;
	url: string | null;
	/** ISO 3166-2 state to select on the map, when the event has one. */
	state: string | null;
}

/** Structural views of the panels (the panel files own the full types). */
interface Quakes {
	items: {
		id: string;
		at: number;
		zone: "venezuela" | "near" | "far";
		state: string | null;
		placeEs: string;
		maxMag: number;
		usgs: { url: string } | null;
		funvisis: { url: string } | null;
	}[];
}
interface Connectivity {
	events: {
		id: string;
		kind: "state" | "isp" | "country";
		key?: string;
		name: string;
		startAt: number;
		endAt: number;
		durationMin: number;
		openAtFetch: boolean;
		url: string;
	}[];
}
interface Money {
	official: {
		usd: {
			current: {
				vesPerUnit: number;
				valueDate: string;
				validFrom: number;
				fetchedAt: number;
				sourceUrl: string;
			} | null;
			next: {
				vesPerUnit: number;
				valueDate: string;
				validFrom: number;
				fetchedAt: number;
				sourceUrl: string;
			} | null;
		};
	};
}
interface Hazards {
	gdacs: {
		events: {
			id: string;
			eventType: string;
			typeEs: string;
			name: string;
			alertLevel: string;
			fromAt: number;
			stateName: string | null;
			url: string;
		}[];
	};
}
interface Censorship {
	timeline?: {
		changes: {
			source: string;
			kind: string;
			domain: string;
			isp: string;
			after: number;
			by: number;
			url: string;
		}[];
	};
}

const LEVEL: Record<string, { es: string; en: string }> = {
	green: { es: "verde", en: "green" },
	orange: { es: "naranja", en: "orange" },
	red: { es: "roja", en: "red" },
};

function day(date: string, lang: Lang): string {
	const [, m = "1", d = "1"] = date.split("-");
	const es = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"];
	const en = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	return lang === "es" ? `${Number(d)} ${es[Number(m) - 1]}` : `${en[Number(m) - 1]} ${Number(d)}`;
}

export function tickerEvents(
	panels: Record<string, unknown>,
	now: number,
	lang: Lang,
	limit = 8,
): TickerEvent[] {
	const es = lang === "es";
	const out: TickerEvent[] = [];

	const quakes = panels.quakes as Quakes | undefined;
	for (const q of quakes?.items ?? []) {
		if (q.zone === "far") continue;
		const who = [q.funvisis ? "FUNVISIS" : null, q.usgs ? "USGS" : null].filter(Boolean).join(" · ");
		out.push({
			id: `quake:${q.id}`,
			kind: "quake",
			at: q.at,
			text: `${es ? "Sismo" : "Quake"} M${num(q.maxMag, 1, lang)} · ${q.placeEs}`,
			source: who,
			url: (q.usgs ?? q.funvisis)?.url ?? null,
			state: q.state,
		});
	}

	const conn = panels.connectivity as Connectivity | undefined;
	for (const e of conn?.events ?? []) {
		const state = e.kind === "state" && e.key?.startsWith("VE-") ? e.key : null;
		out.push({
			id: `outage:${e.id}`,
			kind: "outage",
			at: e.startAt,
			text: `${es ? "Caída de señal" : "Signal drop"} · ${e.name}`,
			source: "IODA",
			url: e.url,
			state,
		});
		if (!e.openAtFetch)
			out.push({
				id: `outage-end:${e.id}`,
				kind: "outage-end",
				at: e.endAt,
				text: `${es ? "Fin de la caída" : "Drop ended"} · ${e.name} · ${e.durationMin} min`,
				source: "IODA",
				url: e.url,
				state,
			});
	}

	const money = panels.money as Money | undefined;
	for (const r of [money?.official.usd.current, money?.official.usd.next]) {
		// A publication is an event only if Vigía saw the rate before it took effect: then fetchedAt is when it
		// appeared on the BCV's site (to within one polling interval). A rate first read from the history file is not.
		if (!r || r.fetchedAt >= r.validFrom) continue;
		out.push({
			id: `rate:${r.valueDate}`,
			kind: "rate",
			at: r.fetchedAt,
			text: es
				? `Dólar BCV ${num(r.vesPerUnit, 2, lang)} Bs para el ${day(r.valueDate, lang)}`
				: `BCV dollar ${num(r.vesPerUnit, 2, lang)} Bs for ${day(r.valueDate, lang)}`,
			source: "BCV",
			url: r.sourceUrl,
			state: null,
		});
	}

	const hazards = panels.hazards as Hazards | undefined;
	for (const g of hazards?.gdacs.events ?? []) {
		if (g.eventType === "EQ" && g.alertLevel === "green") continue;
		out.push({
			id: `gdacs:${g.id}:${g.alertLevel}`,
			kind: "alert",
			at: g.fromAt,
			text: `${es ? g.typeEs : g.name} · ${es ? "alerta" : "alert"} ${LEVEL[g.alertLevel]?.[lang] ?? g.alertLevel}${g.stateName ? ` · ${g.stateName}` : ""}`,
			source: "GDACS",
			url: g.url,
			state: null,
		});
	}

	const cens = panels.censorship as Censorship | undefined;
	for (const c of cens?.timeline?.changes ?? []) {
		const blocked = c.kind === "blocked" || c.kind === "flagged";
		out.push({
			id: `block:${c.source}:${c.kind}:${c.domain}:${c.isp}:${c.by}`,
			kind: blocked ? "block" : "unblock",
			at: c.by,
			text: `${blocked ? (es ? "Bloqueo" : "Block") : es ? "Desbloqueo" : "Unblock"} · ${c.domain} · ${c.isp}`,
			source: c.source === "ooni" ? "OONI" : "VE sin Filtro",
			url: c.url,
			state: null,
		});
	}

	// Newest last (the ticker reads left to right and grows at the right edge). Nothing from the future.
	return out
		.filter((e) => e.at <= now + 60_000)
		.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
		.slice(0, limit)
		.reverse();
}
