/**
 * The words and small rules of the crowd reports ("¿tienes luz, agua, internet, gasolina?"), pure and tested
 * (crowd-view.test.ts): the per-device token as the contract asks (random, in sessionStorage, renewed after a day),
 * what each refusal means in plain Spanish, when a report counts in what is published, and how a published figure
 * reads (always "reportes de usuarios" with its count, never a measurement or a percentage).
 */
import { clock, int, type Lang } from "./format.ts";

const tr = (l: Lang, es: string, en: string) => (l === "es" ? es : en);

/* ---------- The per-device token (LOG 2026-09-28, "UI contract: the per-device token") ---------- */

export const TOKEN_KEY = "vigia:crowd-token";
export const TOKEN_MAX_AGE_MS = 24 * 3_600_000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{22}$/;

/** 16 random bytes, base64url without padding (22 characters). Nothing about the device goes into it. */
export function newToken(
	random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b),
): string {
	const bytes = random(new Uint8Array(16));
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

/**
 * This tab's token: kept in sessionStorage (one across reloads of the tab, forgotten when it closes; never
 * localStorage, IndexedDB or a cookie, which would outlive the visit on a seized phone), made anew after 24 h.
 * Without storage (blocked), a token for this page only: the report still goes, and may count again after a reload.
 */
export function deviceToken(
	storage: Storage | null,
	now: number,
	make: () => string = () => newToken(),
): string {
	try {
		const raw = storage?.getItem(TOKEN_KEY);
		if (raw) {
			const kept = JSON.parse(raw) as { token?: unknown; createdAt?: unknown };
			if (
				typeof kept.token === "string" &&
				TOKEN_SHAPE.test(kept.token) &&
				typeof kept.createdAt === "number" &&
				now - kept.createdAt >= 0 &&
				now - kept.createdAt < TOKEN_MAX_AGE_MS
			)
				return kept.token;
		}
	} catch {
		// Unreadable or blocked: make a new one below.
	}
	const token = make();
	try {
		storage?.setItem(TOKEN_KEY, JSON.stringify({ token, createdAt: now }));
	} catch {
		// Storage blocked: the token lives with this page.
	}
	return token;
}

/** After `400 invalid` (e.g. a stale format): drop the token so the retry makes a new one. */
export function dropToken(storage: Storage | null): void {
	try {
		storage?.removeItem(TOKEN_KEY);
	} catch {
		// Nothing to drop.
	}
}

/* ---------- Refusals, in plain words ---------- */

export type Refusal = { code: string; error: string | null; retryAfterS: number | null; status: number };

/** "en 2 min", "en 1 h": a wait from Retry-After. */
function wait(s: number | null, l: Lang): string | null {
	if (s === null || !Number.isFinite(s) || s <= 0) return null;
	if (s < 90) return tr(l, `en ${Math.max(1, Math.round(s))} s`, `in ${Math.max(1, Math.round(s))} s`);
	if (s < 5_400) return tr(l, `en ${Math.round(s / 60)} min`, `in ${Math.round(s / 60)} min`);
	return tr(l, `en ${Math.round(s / 3_600)} h`, `in ${Math.round(s / 3_600)} h`);
}

/**
 * What a refused report means, for the person who sent it. The server's own sentence (`error`) is shown as given
 * where the contract says so (limits, a proxy): it states the limit; the page adds when to try again.
 */
export function refusalText(r: Refusal, l: Lang): string {
	const again = wait(r.retryAfterS, l);
	switch (r.code) {
		case "rate":
		case "municipalities":
			return `${r.error ?? tr(l, "Llegaste al límite de reportes de esta conexión.", "This connection reached its report limit.")}${
				again ? tr(l, ` Puedes volver a intentarlo ${again}.`, ` You can try again ${again}.`) : ""
			}`;
		case "busy":
			return tr(
				l,
				`Demasiados reportes en tu estado en este minuto: Vigía no acepta más por ahora. Inténtalo de nuevo ${again ?? "en un minuto"}.`,
				`Too many reports in your state this minute: Vigía is not taking more for now. Try again ${again ?? "in a minute"}.`,
			);
		case "proxy":
			return `${r.error ?? ""} ${tr(l, "Es un problema de configuración de este Vigía, no de tu reporte.", "It is a problem with this Vigía's setup, not with your report.")}`.trim();
		case "origin":
			return tr(
				l,
				"Este Vigía solo acepta reportes enviados desde su propia página. Ábrela directamente e inténtalo de nuevo.",
				"This Vigía only takes reports sent from its own page. Open it directly and try again.",
			);
		case "remote":
			return tr(
				l,
				"Este Vigía es personal: solo acepta reportes desde este equipo y su red local.",
				"This Vigía is personal: it only takes reports from this computer and its local network.",
			);
		case "off":
			return tr(
				l,
				"Este Vigía no recibe reportes de usuarios (quien lo administra los apagó).",
				"This Vigía does not take user reports (whoever runs it turned them off).",
			);
		case "invalid":
			return tr(
				l,
				"El reporte no se pudo leer. Revisa el municipio y las respuestas e inténtalo de nuevo.",
				"The report could not be read. Check the municipality and the answers and try again.",
			);
		case "pow":
			return tr(
				l,
				"No se pudo comprobar la prueba de trabajo del envío. Inténtalo de nuevo.",
				"The submission's proof of work could not be checked. Try again.",
			);
		case "network":
			return tr(
				l,
				"No hubo conexión con Vigía: el reporte no se envió. Nada se guardó para enviarlo después.",
				"No connection to Vigía: the report was not sent. Nothing was kept to send later.",
			);
		case "worker":
			return tr(
				l,
				"Este navegador no pudo preparar el envío (no ejecuta el cálculo en segundo plano). Prueba con otro navegador.",
				"This browser could not prepare the report (it does not run the background calculation). Try another browser.",
			);
		default:
			return (
				r.error ??
				tr(
					l,
					`El servidor no aceptó el reporte (${r.status}). Inténtalo de nuevo.`,
					`The server did not take the report (${r.status}). Try again.`,
				)
			);
	}
}

/* ---------- After sending ---------- */

/**
 * When a report would enter what is published (`publishedFrom`: on a public mirror the close of the current 15-minute
 * block, on this machine now). The server says only "received", never whether it was counted, held or replaced (the
 * contract keeps that from anyone sharing the connection), so the page never says it counted. `minReporters`: a
 * mirror shows a figure only from that many reports.
 */
export function publishedText(
	publishedFrom: number,
	now: number,
	l: Lang,
	minReporters: number | null = null,
): string {
	const when =
		publishedFrom <= now + 30_000
			? tr(
					l,
					"Si se cuenta, ya entra en lo publicado.",
					"If it is counted, it is already in what is published.",
				)
			: tr(
					l,
					`Si se cuenta, entra en lo publicado a las ${clock(publishedFrom, l)}, al cerrar el bloque de 15 minutos.`,
					`If it is counted, it enters what is published at ${clock(publishedFrom, l)}, when the 15-minute block closes.`,
				);
	return minReporters && minReporters > 1
		? `${when} ${tr(l, `Un municipio se muestra solo con al menos ${minReporters} reportes.`, `A municipality is shown only with at least ${minReporters} reports.`)}`
		: when;
}

/** "Preparando envío… 40 %": the expected share of the work done (2^difficulty attempts on average; capped at 95 %). */
export function workShare(attempts: number, difficulty: number): number {
	const expected = 2 ** difficulty;
	return Math.min(0.95, 1 - Math.exp(-attempts / expected));
}

/* ---------- Showing published figures ---------- */

export type Answers = { si: number; no: number; intermitente: number };

/** The server's one-line figure without its held clause, when the page says it by answer (`heldText`). */
export function withoutHeld(text: string): string {
	return text.replace(
		/ \((?:[\d.,]+ retenidos por posible manipulación, no se cuentan|[\d.,]+ held as possible manipulation, not counted)\)$/,
		"",
	);
}

/** "posible manipulación: 40 «sí» retenidos, no se cuentan" from the held reports by answer (a flood of one answer is not a flood of the others). */
export function heldText(held: Answers, l: Lang): string | null {
	const parts = (["no", "intermitente", "si"] as const)
		.filter((a) => held[a] > 0)
		.map((a) =>
			tr(
				l,
				`${int(held[a], l)} «${a === "si" ? "sí" : a}»`,
				`${int(held[a], l)} "${a === "si" ? "yes" : a === "no" ? "no" : "on and off"}"`,
			),
		);
	if (!parts.length) return null;
	return tr(
		l,
		`posible manipulación: ${parts.join(", ")} retenidos, no se cuentan`,
		`possible manipulation: ${parts.join(", ")} held, not counted`,
	);
}

/** The outage share of a figure, as a word for a mark (never a percentage): more «no»/«intermitente» than «sí». */
export function outageLean(a: Answers | null): "outage" | "mixed" | "ok" | null {
	if (!a) return null;
	const out = a.no + a.intermitente;
	if (out === 0 && a.si === 0) return null;
	if (out > a.si) return "outage";
	if (out > 0) return "mixed";
	return "ok";
}

/* ---------- The published view (`/api/panels/crowd`, src/panels/crowd.ts), mirrored ---------- */

export interface CrowdItem {
	level: "municipality" | "state";
	entity: string;
	/** ISO 3166-2 of the state. */
	state: string;
	service: "luz" | "agua" | "internet" | "gasolina";
	reports: number | null;
	connections: number;
	answers: Answers | null;
	held: number;
	heldAnswers: Answers;
	flagged: boolean;
	municipalities: number;
	outage: { count: number; connections: number; firstAt: number; lastAt: number } | null;
	windowMs: number;
	name: { es: string; en: string };
	stateName: string | null;
	serviceName: { es: string; en: string };
	label: { es: string; en: string };
	text: { es: string; en: string };
	method: string;
	observedAt: number;
	fetchedAt: number;
	stale: boolean;
}

export interface CrowdView {
	asOf: number;
	basis: "report";
	label: { es: string; en: string };
	windowMs: number;
	mode: "local" | "public" | null;
	source: { id: string; name: string; licence: string; licenceUrl: string; attribution: string };
	municipalities: CrowdItem[];
	states: CrowdItem[];
	counts: { municipalities: number; states: number; flagged: number; reports: number };
	rules: { es: string[]; en: string[] };
}

export const SERVICE_ORDER = ["luz", "agua", "internet", "gasolina"] as const;

/** One place with its services' figures (a municipality or a state), for the panel's rows and the map's marks. */
export interface CrowdPlace {
	entity: string;
	level: "municipality" | "state";
	name: string;
	state: string;
	stateName: string | null;
	items: CrowdItem[];
	/** Reports across its services (a person answering two services counts in both: said as "respuestas"). */
	answers: number;
	/** «no» and «intermitente» across its services. */
	outage: number;
	newest: number;
	stale: boolean;
	flagged: boolean;
}

/** A figure older than this reads "desactualizado" on the page too (the server's `staleAfterMs`, 20 min). */
export const CROWD_STALE_MS = 20 * 60_000;

/**
 * Groups the published figures by place, most outage answers first, then most answers, then by name. The view is
 * cached until the stream says it changed, so the page re-checks each figure on its own clock (`now`): past its
 * window it is dropped, past 20 min it is out of date.
 */
export function crowdPlaces(items: readonly CrowdItem[], l: Lang, now: number = Date.now()): CrowdPlace[] {
	const by = new Map<string, CrowdPlace>();
	for (const raw of items) {
		if (raw.reports === null || now - raw.observedAt > raw.windowMs) continue;
		const it = now - raw.observedAt > CROWD_STALE_MS && !raw.stale ? { ...raw, stale: true } : raw;
		const p = by.get(it.entity) ?? {
			entity: it.entity,
			level: it.level,
			name: it.name[l],
			state: it.state,
			stateName: it.stateName,
			items: [],
			answers: 0,
			outage: 0,
			newest: 0,
			stale: false,
			flagged: false,
		};
		p.items.push(it);
		p.answers += raw.reports;
		p.outage += (it.answers?.no ?? 0) + (it.answers?.intermitente ?? 0);
		p.newest = Math.max(p.newest, it.observedAt);
		p.stale ||= it.stale;
		p.flagged ||= it.flagged;
		by.set(it.entity, p);
	}
	for (const p of by.values())
		p.items.sort((a, b) => SERVICE_ORDER.indexOf(a.service) - SERVICE_ORDER.indexOf(b.service));
	return [...by.values()].sort(
		(a, b) => b.outage - a.outage || b.answers - a.answers || a.name.localeCompare(b.name, "es"),
	);
}

/** "1 reporte", "5 reportes de 2 conexiones": the count as the contract says it, never a percentage. */
export function reportsWord(it: Pick<CrowdItem, "reports" | "connections">, l: Lang): string {
	const r = it.reports ?? 0;
	const base = tr(
		l,
		`${int(r, l)} ${r === 1 ? "reporte" : "reportes"}`,
		`${int(r, l)} ${r === 1 ? "report" : "reports"}`,
	);
	if (it.connections > 0 && it.connections < r)
		return tr(
			l,
			`${base} de ${int(it.connections, l)} ${it.connections === 1 ? "conexión" : "conexiones"}`,
			`${base} from ${int(it.connections, l)} ${it.connections === 1 ? "connection" : "connections"}`,
		);
	return base;
}
