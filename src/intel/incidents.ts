/**
 * Incidents: independent signals that agree about one place and one kind of event, fused into one item with its
 * evidence chain. Deterministic and pure: the same signals and the same previous incidents always give the same
 * incidents. No probability is invented; the only strength shown is how many INDEPENDENT source families agree
 * (IODA, RIPE Atlas, NASA VIIRS, USGS, FUNVISIS, the press, users' own reports), each with its own figures, times
 * and links.
 *
 * The rules are the constants below; `rulesText` turns them into the words the UI shows behind "?", so the text
 * can never drift from the code.
 */

import { CAMERA_RULES } from "../cameras/rules.ts";
import type { Basis } from "../core/types.ts";
import { CROWD_RULES } from "../crowd/rules.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

export type IncidentKind = "corte" | "sismo";

/**
 * A family is one independent way of knowing: one measurement network, or the press as a whole. Two outlets are
 * one family (they read each other); IODA's signals and IODA's own events are one family (same probes).
 */
export type Family =
	| "ioda"
	| "ripe-atlas"
	| "cloudflare"
	| "viirs"
	| "usgs"
	| "funvisis"
	| "prensa"
	| "gdacs"
	| "usuarios"
	| "camaras";

export const FAMILIES: Record<
	Family,
	{ readonly es: string; readonly en: string; readonly basis: Extract<Basis, "measurement" | "report"> }
> = {
	ioda: { es: "IODA (medición de internet)", en: "IODA (internet measurement)", basis: "measurement" },
	"ripe-atlas": { es: "RIPE Atlas (sondas)", en: "RIPE Atlas (probes)", basis: "measurement" },
	// Cloudflare's outage notes and verified anomalies are its analysts' attributed statements: reports.
	cloudflare: { es: "Cloudflare Radar (tráfico)", en: "Cloudflare Radar (traffic)", basis: "report" },
	viirs: { es: "NASA VIIRS (luces nocturnas)", en: "NASA VIIRS (night lights)", basis: "measurement" },
	usgs: { es: "USGS (red sísmica)", en: "USGS (seismic network)", basis: "measurement" },
	funvisis: { es: "FUNVISIS (red sísmica)", en: "FUNVISIS (seismic network)", basis: "measurement" },
	prensa: { es: "Prensa (reportes)", en: "Press (reports)", basis: "report" },
	gdacs: { es: "GDACS (alertas)", en: "GDACS (alerts)", basis: "measurement" },
	usuarios: { es: "Reportes de usuarios", en: "User reports", basis: "report" },
	camaras: {
		es: "Cámaras públicas (brillo nocturno)",
		en: "Public cameras (night brightness)",
		basis: "measurement",
	},
};

/** What a piece of evidence speaks to; it picks the incident's title ("apagón" only with power-specific evidence). */
export type Speaks = "power" | "internet" | "connectivity" | "quake" | "hazard";

/** A stored observation behind a piece of evidence; `observedAt` null means "the newest revision". */
export type ObsRef = { source: string; series: string; observedAt: number | null };

export type Evidence = {
	/** Stable across recomputes: the same fact keeps the same id (e.g. "ioda:drop:VE-K"). */
	id: string;
	family: Family;
	/** "signal" counts toward corroboration; "context" (a possible cause nearby) is shown but never counted. */
	role: "signal" | "context";
	speaks: Speaks;
	/** Adapter id. */
	feed: string;
	/** One line, with its figure: "IODA: sondeo activo al 72 % de lo normal a esta hora". */
	es: string;
	en: string;
	/** When the fact was first true (an outage's start, a headline's publication). */
	at: number;
	/** When it was last seen true; equals `at` for point facts. */
	lastAt: number;
	fetchedAt: number | null;
	url: string;
	/** News only: the outlet id (the "two different outlets" rule). */
	outlet: string | null;
	refs: ObsRef[];
};

export type Signal = {
	kind: IncidentKind;
	/** Subject: a state ISO code for "corte", a quake id for "sismo". */
	key: string;
	state: string | null;
	/** The moment the subject is anchored to (the quake's origin time); null for "corte". */
	anchorAt: number | null;
	/** Fixed title for subjects that carry their own (a quake); null to derive it from the evidence. */
	title: { es: string; en: string } | null;
	evidence: Evidence;
};

export type LateCorroboration = {
	family: Family;
	evidenceId: string;
	/** When Vigía received it. */
	arrivedAt: number;
	/** How long after the fact it was published (fetch time − the fact's time). */
	delayMs: number;
};

export type Incident = {
	id: string;
	kind: IncidentKind;
	key: string;
	state: string | null;
	anchorAt: number | null;
	title: { es: string; en: string };
	/** Earliest signal evidence. */
	startAt: number;
	/** Newest signal evidence (never moves back). */
	lastEvidenceAt: number;
	/**
	 * "incident": two or more independent families (or press from two outlets, labelled). "watch": one measured
	 * family alone ("señal sin corroborar"), never counted as an incident.
	 */
	tier: "incident" | "watch";
	/** When Vigía first opened it as an incident (for a watch item: when it was first seen). */
	openedAt: number;
	/** A watch item that became an incident: when it was first seen as a watch; null otherwise. */
	watchSince: number | null;
	/** How it opened: two or more families, press from two or more outlets, or one measured family (a watch). */
	openedBy: "families" | "reports" | "single";
	/** Evidence that arrived after the fact and corroborated it later (night lights): when, and how late. */
	late: LateCorroboration[];
	/** Signal families in the chain, in a fixed order. */
	families: Family[];
	/** Number of independent families: the only strength Vigía states. */
	corroboration: number;
	/** Only the press: no measurement confirms it. */
	reportsOnly: boolean;
	/** Distinct outlets among the reports. */
	outlets: number;
	/** Signal evidence, oldest first (capped; `evidenceTotal` says how many existed). */
	evidence: Evidence[];
	evidenceTotal: number;
	context: Evidence[];
};

export const RULES = {
	/** How far back each family's evidence can be and still count ("stale signals don't count"). */
	freshMs: {
		ioda: 12 * HOUR,
		"ripe-atlas": 3 * HOUR,
		// Cloudflare's outage notes and verified anomalies, like IODA's events: counted up to 12 h after they end.
		cloudflare: 12 * HOUR,
		// NASA publishes a night ~1–1.5 days after the overpass: the newest night available.
		viirs: 48 * HOUR,
		usgs: 24 * HOUR,
		funvisis: 24 * HOUR,
		prensa: 12 * HOUR,
		gdacs: 24 * HOUR,
		// A municipality's reports cover the last two hours (src/crowd/rules.ts); an hour of slack for publishing.
		usuarios: CROWD_RULES.windowMs + HOUR,
		// A dark camera counts while its last dark still is this recent (src/cameras/rules.ts).
		camaras: CAMERA_RULES.evidenceFreshMs,
	} satisfies Record<Family, number>,
	/**
	 * Signals of different families must lie this close in time to open an incident together (or to join an open
	 * one): a night-lights dip of two nights ago and an internet drop now are not the same event.
	 */
	togetherMs: 6 * HOUR,
	/** The same fact seen again after this long a gap is a new episode (an IODA drop that recovered and came back). */
	episodeGapMs: 30 * MIN,
	/** An open incident stays active while new evidence keeps arriving; this long without any, it has ended. */
	activeMs: 3 * HOUR,
	/**
	 * Late evidence (published long after the fact) may corroborate an incident or watch item, active or ended, whose
	 * time span it overlaps within `togetherMs`, when that item's last evidence is at most this old.
	 */
	lateMs: 72 * HOUR,
	/** What alone makes a watch item ("señal sin corroborar"): calibrated, docs in the repository's decisions. */
	// Replay 2026-09-25: any single measured signal made 428 watch items in 16 quiet windows; without IODA's plain
	// one-signal drop 181 (that drop is no longer evidence at all, SIGNAL_RULES.iodaLevels); without IODA's own
	// outage events too, 47 but covering 27 of 109 blackout-state pairs instead of 59. IODA events stay.
	watch: { iodaEvents: true } as { iodaEvents: boolean },
	/** Families needed to open an incident from measurements. */
	minFamilies: 2,
	/** Press alone opens an incident (labelled "solo reportes") only with this many different outlets. */
	minOutletsReportsOnly: 2,
	/** Two quake subjects are the same quake when their origin times are this close (the quakes panel rule). */
	sameQuakeMs: 90_000,
	/** Evidence kept per incident (the count of all of it is kept too); at least `minReportsKept` of it reports. */
	maxEvidence: 40,
	minReportsKept: 10,
	/** A clock skew allowance: evidence dated slightly in the future still counts. */
	futureSlackMs: 15 * MIN,
} as const;

export const FAMILY_ORDER: readonly Family[] = [
	"ioda",
	"ripe-atlas",
	"cloudflare",
	"viirs",
	"usgs",
	"funvisis",
	"gdacs",
	"prensa",
	"usuarios",
	"camaras",
];

/** Families of reports, not measurements: incidents made only of them are "solo reportes". */
export const REPORT_FAMILIES: readonly Family[] = ["prensa", "usuarios"];

/**
 * Families that can only join an incident other families opened: users' reports. They never count toward opening one
 * or promoting a watch item, never make its title ("apagón"), and never keep it active or move its start on their own
 * (a few addresses must not turn a lone IODA drop into "Posible apagón", or keep an ended one going).
 * Cloudflare Radar is join-only too until a replay of the archive shows how often it agrees with the others (a new
 * family is calibrated before it may open incidents).
 */
export const JOIN_ONLY: readonly Family[] = ["usuarios", "camaras", "cloudflare"];

/** Families that count toward opening an incident (RULES.minFamilies): every one but the join-only ones. */
export function openingFamilies(families: readonly Family[]): number {
	return families.filter((f) => !JOIN_ONLY.includes(f)).length;
}

/** The evidence that dates an incident and names it: everything but the join-only families (all of it if that is all). */
function anchoring(evidence: readonly Evidence[]): readonly Evidence[] {
	const own = evidence.filter((e) => !JOIN_ONLY.includes(e.family));
	return own.length > 0 ? own : evidence;
}

/** Families whose data is published long after the fact by design (NASA publishes a night 36–43 h later). */
export const LATE_FAMILIES: readonly Family[] = ["viirs"];

/** Measured families: one of them alone makes a watch item ("señal sin corroborar"). */
export const MEASURED: readonly Family[] = ["ioda", "ripe-atlas", "viirs"];

const hours = (ms: number) => Math.round(ms / HOUR);

/** The rules in words, generated from RULES: what the UI shows behind "?". */
export function rulesText(): { es: string[]; en: string[] } {
	const f = RULES.freshMs;
	return {
		es: [
			"Un incidente reúne señales independientes sobre el mismo lugar y el mismo tipo de hecho. Vigía no calcula probabilidades: dice cuántas familias de fuentes independientes coinciden.",
			`Una señal sola nunca es un incidente. Hace falta que coincidan al menos ${RULES.minFamilies} familias distintas de las que pueden abrir uno (IODA, RIPE Atlas, NASA VIIRS, USGS, FUNVISIS, prensa); los reportes de usuarios, las cámaras públicas y Cloudflare Radar solo se suman a uno ya abierto.`,
			`Excepción: si solo hay prensa, hacen falta al menos ${RULES.minOutletsReportsOnly} medios distintos, y el incidente se marca «solo reportes» (ninguna medición lo confirma).`,
			`Los reportes de usuarios son su propia familia, pero solo se suman a un incidente que otras fuentes ya abrieron: nunca abren uno, ni convierten una señal sin corroborar en incidente, ni ponen el título («apagón»), ni lo mantienen activo o mueven su inicio por sí solos. Cuentan los de un municipio con al menos ${CROWD_RULES.incident.minOutageReports.public} reportes, de al menos ${CROWD_RULES.incident.minOutageConnections.public} conexiones distintas, que responden «no» o «intermitente» sobre la luz o internet en las últimas ${hours(CROWD_RULES.windowMs)} h (${CROWD_RULES.incident.minOutageReports.local} en un Vigía propio, donde son los del hogar), y nunca si alguna de esas respuestas se retuvo por posible manipulación.`,
			`Las cámaras públicas cuyo brillo nocturno cae a ${Math.round(CAMERA_RULES.darkRatio * 100)} % o menos de su propia línea base (misma hora, ${CAMERA_RULES.baselineDays} días, al menos ${CAMERA_RULES.minBaselineNights} noches) en ${CAMERA_RULES.darkStills} imágenes seguidas son otra familia que solo se suma, igual que los reportes de usuarios: la niebla o un cambio de exposición también oscurecen una imagen. Cuentan ${hours(CAMERA_RULES.evidenceFreshMs)} h después de la última imagen oscura.`,
			"Cloudflare Radar (con el token gratuito de Cloudflare) también solo se suma, hasta que una reproducción del archivo muestre cuánto coincide con las demás: sus notas de cortes se suman a los estados que nombran, o a todos si Cloudflare las llama nacionales, y sus anomalías de tráfico verificadas de todo el país se suman a todos; las de una sola red, no.",
			"Varios medios cuentan como una sola familia (se leen entre sí); las señales y los eventos de IODA también son una sola.",
			`Las señales viejas no cuentan: IODA hasta ${hours(f.ioda)} h después de terminar, prensa ${hours(f.prensa)} h, RIPE Atlas ${hours(f["ripe-atlas"])} h, reportes de usuarios ${hours(f.usuarios)} h, Cloudflare Radar ${hours(f.cloudflare)} h, sismos ${hours(f.usgs)} h, luces nocturnas ${hours(f.viirs)} h (NASA publica cada noche con 1 a 1,5 días de retraso).`,
			`Las señales de familias distintas tienen que coincidir en el tiempo: a menos de ${hours(RULES.togetherMs)} h entre sí (una caída de luces de hace dos noches y una caída de internet de ahora no son el mismo hecho).`,
			`Activo mientras llegue evidencia nueva; terminado tras ${hours(RULES.activeMs)} h sin evidencia nueva de ninguna fuente. «Terminado» no significa resuelto.`,
			"«Posible apagón» solo cuando hay evidencia eléctrica medida o publicada (luces nocturnas o titulares de cortes de luz; los reportes de usuarios sin luz no bastan); si solo hay mediciones de internet, dice «caída de conectividad»: puede ser un corte eléctrico o una falla de red.",
			`Una sola familia medida (${MEASURED.map((f) => FAMILIES[f].es.split(" (")[0]).join(", ")}) no es un incidente: se muestra aparte como «señal sin corroborar» y no se cuenta. Si otra familia coincide después, pasa a ser incidente desde ese momento.`,
			`Las luces nocturnas llegan tarde (NASA publica cada noche 1 a 2 días después): una caída de luces puede corroborar después un incidente o una señal sin corroborar, activos o terminados hace menos de ${hours(RULES.lateMs)} h, cuyo lapso coincida; se marca «corroborado después» con el retraso de publicación, y su hora de inicio no cambia.`,
			"Contexto (un sismo, una alerta de GDACS en el estado) se muestra como posible causa y nunca cuenta como confirmación.",
			"Los reportes se etiquetan por palabras clave, no por un modelo: el titular está enlazado para que cada quien lo juzgue.",
		],
		en: [
			"An incident gathers independent signals about the same place and the same kind of event. Vigía computes no probabilities: it says how many independent source families agree.",
			`One signal alone is never an incident. At least ${RULES.minFamilies} different families that can open one must agree (IODA, RIPE Atlas, NASA VIIRS, USGS, FUNVISIS, press); user reports, public cameras and Cloudflare Radar only join one already open.`,
			`Exception: with press alone, at least ${RULES.minOutletsReportsOnly} different outlets are needed, and the incident is marked "reports only" (no measurement confirms it).`,
			`User reports are their own family, but only join an incident other sources already opened: they never open one, never turn an uncorroborated signal into an incident, never set its title ("blackout"), and never keep it active or move its start on their own. A municipality's reports count with at least ${CROWD_RULES.incident.minOutageReports.public} reports, from at least ${CROWD_RULES.incident.minOutageConnections.public} different connections, answering "no" or "on and off" about power or internet in the last ${hours(CROWD_RULES.windowMs)} h (${CROWD_RULES.incident.minOutageReports.local} on a personal Vigía, where they are the household's), and never when any of those answers was held as possible manipulation.`,
			`Public cameras whose night brightness falls to ${Math.round(CAMERA_RULES.darkRatio * 100)} % or less of their own baseline (same hour, ${CAMERA_RULES.baselineDays} days, at least ${CAMERA_RULES.minBaselineNights} nights) in ${CAMERA_RULES.darkStills} stills in a row are another family that only joins, like user reports: fog or an exposure change also darken a picture. They count for ${hours(CAMERA_RULES.evidenceFreshMs)} h after the last dark still.`,
			"Cloudflare Radar (with Cloudflare's free token) only joins too, until a replay of the archive shows how often it agrees with the others: its outage notes join the states they name, or every state when Cloudflare calls them nationwide, and its verified country-wide traffic anomalies join every state; those of a single network do not.",
			"Several outlets count as one family (they read each other); IODA's signals and events are one family too.",
			`Old signals do not count: IODA up to ${hours(f.ioda)} h after it ends, press ${hours(f.prensa)} h, RIPE Atlas ${hours(f["ripe-atlas"])} h, user reports ${hours(f.usuarios)} h, Cloudflare Radar ${hours(f.cloudflare)} h, earthquakes ${hours(f.usgs)} h, night lights ${hours(f.viirs)} h (NASA publishes each night 1 to 1.5 days late).`,
			`Signals of different families must coincide in time: within ${hours(RULES.togetherMs)} h of each other (a night-lights dip two nights ago and an internet drop now are not the same event).`,
			`Active while new evidence arrives; ended after ${hours(RULES.activeMs)} h with no new evidence from any source. "Ended" does not mean resolved.`,
			'"Possible blackout" only with power evidence (night lights or headlines of power cuts; user reports without power are not enough); with internet measurements only it says "connectivity drop": it may be a power cut or a network failure.',
			`One measured family alone (${MEASURED.map((f) => FAMILIES[f].en.split(" (")[0]).join(", ")}) is not an incident: it is shown apart as an "uncorroborated signal" and never counted. If another family agrees later, it becomes an incident from that moment.`,
			`Night lights arrive late (NASA publishes each night 1 to 2 days after): a drop in night lights may later corroborate an incident or uncorroborated signal, active or ended less than ${hours(RULES.lateMs)} h ago, whose time span it overlaps; it is marked "corroborated later" with the publication delay, and its start time does not change.`,
			"Context (an earthquake, a GDACS alert in the state) is shown as a possible cause and never counts as confirmation.",
			"Reports are tagged by keywords, not by a model: the headline is linked so everyone can judge it.",
		],
	};
}

/** Whether evidence is recent enough to count at `now`. */
export function isFresh(e: Evidence, now: number): boolean {
	return e.lastAt >= now - RULES.freshMs[e.family] && e.at <= now + RULES.futureSlackMs;
}

function familiesOf(evidence: readonly Evidence[]): Family[] {
	const set = new Set(evidence.filter((e) => e.role === "signal").map((e) => e.family));
	return FAMILY_ORDER.filter((f) => set.has(f));
}

function outletCount(evidence: readonly Evidence[]): number {
	return new Set(evidence.filter((e) => e.family === "prensa" && e.outlet).map((e) => e.outlet)).size;
}

/** Whether a piece of evidence alone makes a watch item (RULES.watch). */
export function watchable(e: Evidence): boolean {
	if (!MEASURED.includes(e.family)) return false;
	if (e.feed === "ioda-events" && !RULES.watch.iodaEvents) return false;
	return true;
}

/** Distance in time between two facts' intervals (0 when they overlap). */
function gap(a: Pick<Evidence, "at" | "lastAt">, b: Pick<Evidence, "at" | "lastAt">): number {
	return Math.max(0, a.at - b.lastAt, b.at - a.lastAt);
}

/** Keeps the evidence that coincides in time (within `togetherMs`) with evidence of another family. */
export function coinciding(evidence: readonly Evidence[]): Evidence[] {
	return evidence.filter((e) => evidence.some((o) => o.family !== e.family && gap(e, o) <= RULES.togetherMs));
}

/**
 * The opening rule on fresh signal evidence: null when these signals do not make an incident. Join-only evidence is
 * left out entirely: it neither counts nor bridges (two measured signals hours apart do not "coincide" through a
 * long Cloudflare note or a window of users' reports that spans both), and it does not stop press-only reports.
 */
export function opens(all: readonly Evidence[]): Incident["openedBy"] | null {
	const own = all.filter((e) => !JOIN_ONLY.includes(e.family));
	const press = own.filter((e) => e.family === "prensa");
	const families = familiesOf(coinciding(own));
	if (openingFamilies(families) >= RULES.minFamilies) return "families";
	// Press from two outlets opens "solo reportes"; join-only evidence alongside it does not change that.
	if (
		own.length > 0 &&
		own.every((e) => REPORT_FAMILIES.includes(e.family)) &&
		outletCount(press) >= RULES.minOutletsReportsOnly
	) {
		return "reports";
	}
	return null;
}

export function sameSubject(
	a: Pick<Incident, "kind" | "key" | "anchorAt">,
	b: Pick<Signal, "kind" | "key" | "anchorAt">,
): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "sismo" && a.anchorAt !== null && b.anchorAt !== null)
		return Math.abs(a.anchorAt - b.anchorAt) <= RULES.sameQuakeMs;
	return a.key === b.key;
}

export function isActive(incident: Pick<Incident, "lastEvidenceAt">, now: number): boolean {
	return now - incident.lastEvidenceAt <= RULES.activeMs;
}

/** Title for a "corte" from what the evidence speaks to. */
export function corteTitle(evidence: readonly Evidence[], stateName: string): { es: string; en: string } {
	const speaks = new Set(
		evidence.filter((e) => e.role === "signal" && !JOIN_ONLY.includes(e.family)).map((e) => e.speaks),
	);
	if (speaks.has("power"))
		return { es: `Posible apagón en ${stateName}`, en: `Possible blackout in ${stateName}` };
	if (speaks.has("internet"))
		return {
			es: `Posible caída de internet en ${stateName}`,
			en: `Possible internet outage in ${stateName}`,
		};
	return { es: `Caída de conectividad en ${stateName}`, en: `Connectivity drop in ${stateName}` };
}

/**
 * Merges evidence by id: a fact seen again keeps its first time and takes the newest last time and wording (an
 * IODA outage that is still going gets longer; the same headline is one item).
 */
export function mergeEvidence(previous: readonly Evidence[], fresh: readonly Evidence[]): Evidence[] {
	const byId = new Map(previous.map((e) => [e.id, e]));
	const base = (id: string) => id.split("@")[0] as string;
	for (const e of fresh) {
		// The newest episode of this fact, if any.
		let key: string | null = null;
		for (const [k, v] of byId)
			if (base(k) === e.id && (key === null || v.lastAt > (byId.get(key)?.lastAt ?? 0))) key = k;
		const old = key === null ? undefined : byId.get(key);
		if (key === null || !old) {
			byId.set(e.id, e);
		} else if (e.at > old.lastAt + RULES.episodeGapMs) {
			// Seen again after a gap: a new episode, kept apart so the timeline shows the recovery in between.
			byId.set(`${e.id}@${e.at}`, { ...e, id: `${e.id}@${e.at}` });
		} else {
			byId.set(key, { ...e, id: key, at: Math.min(old.at, e.at), lastAt: Math.max(old.lastAt, e.lastAt) });
		}
	}
	return [...byId.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/** The measured evidence and the newest reports of the families that open incidents, within `max`. */
function capOpening(evidence: readonly Evidence[], max: number): Evidence[] {
	if (evidence.length <= max) return [...evidence];
	// Keep every measurement and the newest reports: measurements are few and carry the timeline.
	const measured = evidence.filter((e) => !REPORT_FAMILIES.includes(e.family));
	const reports = evidence.filter((e) => REPORT_FAMILIES.includes(e.family));
	const reportRoom = Math.max(Math.min(reports.length, RULES.minReportsKept), max - measured.length);
	const keptReports = reportRoom > 0 ? reports.slice(-reportRoom) : [];
	return [...measured.slice(-(max - keptReports.length)), ...keptReports];
}

/**
 * At most `maxEvidence` items. The families that open incidents are kept first; join-only evidence (users' reports,
 * cameras, Cloudflare) only fills the room left, with its newest item per family always kept so the family is still
 * named. Whole-release review, M2: 42 crowd items competed with the press for the report slots and pushed out the
 * one headline that had opened "Posible apagón", so the next pass re-derived a different title and families.
 */
function capEvidence(evidence: readonly Evidence[]): Evidence[] {
	if (evidence.length <= RULES.maxEvidence) return [...evidence];
	const joining = evidence.filter((e) => JOIN_ONLY.includes(e.family));
	const keptOpening = capOpening(
		evidence.filter((e) => !JOIN_ONLY.includes(e.family)),
		RULES.maxEvidence,
	);
	const newestPerFamily = JOIN_ONLY.map((f) => joining.filter((e) => e.family === f).at(-1)).filter(
		(e): e is Evidence => e !== undefined,
	);
	const room = Math.max(0, RULES.maxEvidence - keptOpening.length - newestPerFamily.length);
	const others = joining.filter((e) => !newestPerFamily.includes(e));
	const keptJoining = [...(room > 0 ? others.slice(-room) : []), ...newestPerFamily];
	return [...keptOpening, ...keptJoining].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

type Group = {
	kind: IncidentKind;
	key: string;
	state: string | null;
	anchorAt: number | null;
	signals: Signal[];
};

function group(signals: readonly Signal[]): Group[] {
	const groups: Group[] = [];
	for (const s of signals) {
		const hit = groups.find((g) => sameSubject(g, s));
		if (hit) hit.signals.push(s);
		else groups.push({ kind: s.kind, key: s.key, state: s.state, anchorAt: s.anchorAt, signals: [s] });
	}
	return groups;
}

/** The same stored fact cited twice (one headline under two ids, one bin twice) counts once. */
function factKey(e: Evidence): string {
	const refs = e.refs.filter((r) => r.observedAt !== null);
	return refs.length === 0 || refs.length !== e.refs.length
		? `id:${e.id}`
		: refs
				.map((r) => `${r.source}|${r.series}|${r.observedAt}`)
				.sort()
				.join(";");
}

/** Evidence deduplicated by fact, the first by id kept, in a fixed order. */
export function dedupe(evidence: readonly Evidence[]): Evidence[] {
	const byFact = new Map<string, Evidence>();
	for (const e of [...evidence].sort((a, b) => a.id.localeCompare(b.id) || a.lastAt - b.lastAt)) {
		const k = factKey(e);
		const old = byFact.get(k);
		// The same id seen twice keeps its widest interval.
		if (!old) byFact.set(k, e);
		else if (old.id === e.id)
			byFact.set(k, { ...old, at: Math.min(old.at, e.at), lastAt: Math.max(old.lastAt, e.lastAt) });
	}
	return [...byFact.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/**
 * Splits evidence into runs that touch in time (each piece within `togetherMs` of another in its run, any family).
 * A run with two families always has two that coincide, so a run is one candidate event. Runs are made of the
 * families that can open an incident; join-only evidence is then attached to the runs whose span (± `togetherMs`) it
 * overlaps, so it can never chain two distant runs into one.
 */
export function runs(evidence: readonly Evidence[]): Evidence[][] {
	const own = evidence.filter((e) => !JOIN_ONLY.includes(e.family));
	const joiners = evidence.filter((e) => JOIN_ONLY.includes(e.family));
	return ownRuns(own).map((run) => {
		const from = Math.min(...run.map((e) => e.at)) - RULES.togetherMs;
		const to = Math.max(...run.map((e) => e.lastAt)) + RULES.togetherMs;
		return [...run, ...joiners.filter((j) => j.lastAt >= from && j.at <= to)].sort(
			(a, b) => a.at - b.at || a.id.localeCompare(b.id),
		);
	});
}

function ownRuns(evidence: readonly Evidence[]): Evidence[][] {
	const sorted = [...evidence].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
	const out: Evidence[][] = [];
	let current: Evidence[] = [];
	let reach = Number.NEGATIVE_INFINITY;
	for (const e of sorted) {
		if (current.length > 0 && e.at > reach + RULES.togetherMs) {
			out.push(current);
			current = [];
			reach = Number.NEGATIVE_INFINITY;
		}
		current.push(e);
		reach = Math.max(reach, e.lastAt);
	}
	if (current.length > 0) out.push(current);
	return out;
}

function build(
	g: Group,
	chain: Evidence[],
	context: Evidence[],
	openedBy: Incident["openedBy"],
	continuing: Incident | null,
	now: number,
	stateName: (iso: string) => string,
	late: LateCorroboration[] = [],
): Incident {
	const wasIncident = continuing !== null && continuing.tier === "incident";
	const tier: Incident["tier"] =
		wasIncident || openedBy === "reports" || openingFamilies(familiesOf(chain)) >= RULES.minFamilies
			? "incident"
			: "watch";
	// A watch item is one measured family, nothing else (whole-release review, M3: on the next pass a watch took in a
	// dark camera and read "2 familias" under "una sola fuente medida"). Join-only families only join incidents.
	if (tier === "watch") chain = chain.filter((e) => !JOIN_ONLY.includes(e.family));
	const families = familiesOf(chain);
	const dated = anchoring(chain);
	const startAt = Math.min(...dated.map((e) => e.at));
	const newest = Math.max(...dated.map((e) => e.lastAt));
	const lastEvidenceAt = Math.max(newest, continuing?.lastEvidenceAt ?? Number.NEGATIVE_INFINITY);
	const title =
		g.signals.find((s) => s.title)?.title ??
		(g.state ? corteTitle(chain, stateName(g.state)) : { es: "Incidente", en: "Incident" });
	// A watch item that a second family joined is an incident from now: its detection time is this moment.
	const promoted = continuing !== null && continuing.tier === "watch" && tier === "incident";
	const allLate = [...(continuing?.late ?? [])];
	for (const l of late) if (!allLate.some((x) => x.evidenceId === l.evidenceId)) allLate.push(l);
	return {
		id: continuing?.id ?? `${g.kind}:${g.key}:${startAt}`,
		kind: g.kind,
		key: g.key,
		state: g.state,
		anchorAt: g.anchorAt,
		title,
		startAt: Math.min(startAt, continuing?.startAt ?? startAt),
		lastEvidenceAt,
		tier,
		openedAt: promoted || !continuing ? now : continuing.openedAt,
		watchSince: promoted ? continuing.openedAt : (continuing?.watchSince ?? null),
		openedBy: promoted ? "families" : openedBy,
		late: allLate,
		families,
		corroboration: families.length,
		reportsOnly: reportsOnlyOf(families),
		outlets: outletCount(chain),
		evidence: capEvidence(chain),
		evidenceTotal: Math.max(chain.length, continuing?.evidenceTotal ?? 0),
		context: context.slice(-8),
	};
}

/**
 * Turns this moment's signals into incidents, continuing `previous` ones (from the archive) where the subject is
 * the same and the previous incident is still active. Returns every incident touched now; `previous` incidents
 * with no new signal are left as they were (their status follows from their last evidence time).
 *
 * A fixed point: computing again on the same signals with this result archived gives the same incidents. So a
 * fact cited by an earlier incident of the subject is never cited again by a later one, and fresh evidence is
 * split into runs that touch in time, each run its own candidate (a report hours after a measured drop is not
 * dropped, and is not merged into it either).
 */
export function correlate(
	signals: readonly Signal[],
	previous: readonly Incident[],
	now: number,
	stateName: (iso: string) => string,
): Incident[] {
	const fresh = signals.filter((s) => isFresh(s.evidence, now));
	const out: Incident[] = [];
	for (const g of group(fresh)) {
		const candidates = previous
			.filter((p) => sameSubject(p, g))
			.sort((a, b) => b.lastEvidenceAt - a.lastEvidenceAt || a.id.localeCompare(b.id));
		const latest = candidates[0];
		const continuing = latest && isActive(latest, now) ? latest : null;
		// Facts cited by an earlier item of this subject (not the one continuing) cannot be cited again; the same kind
		// of fact seen later than it was cited (a new drop in the same state) can.
		const usedUntil = new Map<string, number>();
		for (const p of candidates) {
			if (p === continuing) continue;
			for (const e of [...p.evidence, ...p.context]) {
				const base = e.id.split("@")[0] as string;
				usedUntil.set(base, Math.max(usedUntil.get(base) ?? 0, p.lastEvidenceAt, e.lastAt));
			}
		}
		const unused = (e: Evidence) => (usedUntil.get(e.id) ?? Number.NEGATIVE_INFINITY) < e.lastAt;
		const all = dedupe(g.signals.map((s) => s.evidence)).filter(unused);
		const signalEv = all.filter((e) => e.role === "signal");
		const contextEv = all.filter((e) => e.role === "context");
		const lateOf = (e: Evidence): LateCorroboration => ({
			family: e.family,
			evidenceId: e.id,
			arrivedAt: now,
			delayMs: Math.max(0, (e.fetchedAt ?? now) - e.at),
		});
		const isLate = (e: Evidence) => LATE_FAMILIES.includes(e.family);
		let rest = signalEv;
		if (continuing) {
			// Joining an open item needs coincidence in time with it; what is older stays out of it.
			const near = signalEv.filter((e) => e.lastAt >= continuing.startAt - RULES.togetherMs);
			rest = signalEv.filter((e) => !near.includes(e));
			const chain = dedupe(mergeEvidence(continuing.evidence, near));
			const known = new Set(continuing.evidence.map((e) => e.id));
			out.push(
				build(
					g,
					chain,
					mergeEvidence(continuing.context, contextEv),
					continuing.openedBy,
					continuing,
					now,
					stateName,
					near.filter((e) => isLate(e) && !known.has(e.id)).map(lateOf),
				),
			);
		}
		// Late evidence corroborates the recent item (active or ended) whose time span it overlaps.
		const overlaps = (c: Incident, e: Evidence) =>
			e.at <= c.lastEvidenceAt + RULES.togetherMs && e.lastAt >= c.startAt - RULES.togetherMs;
		const attached = new Map<Incident, Evidence[]>();
		for (const e of rest.filter(isLate)) {
			const target = candidates.find(
				(c) => c !== continuing && now - c.lastEvidenceAt <= RULES.lateMs && overlaps(c, e),
			);
			if (!target) continue;
			attached.set(target, [...(attached.get(target) ?? []), e]);
		}
		for (const [target, evidence] of attached) {
			const known = new Set(target.evidence.map((e) => e.id));
			out.push(
				build(
					g,
					dedupe(mergeEvidence(target.evidence, evidence)),
					target.context,
					target.openedBy,
					target,
					now,
					stateName,
					evidence.filter((e) => !known.has(e.id)).map(lateOf),
				),
			);
		}
		if (continuing) continue;
		const taken = new Set([...attached.values()].flat());
		for (const run of runs(rest.filter((e) => !taken.has(e)))) {
			const from = Math.min(...run.map((e) => e.at)) - RULES.togetherMs;
			const to = Math.max(...run.map((e) => e.lastAt)) + RULES.togetherMs;
			const context = mergeEvidence(
				[],
				contextEv.filter((e) => e.lastAt >= from && e.at <= to),
			);
			const rule = opens(run);
			if (rule) {
				out.push(build(g, mergeEvidence([], run), context, rule, null, now, stateName));
				continue;
			}
			// One measured family alone: a watch item for a place ("corte"), never an incident.
			const measured = run.filter(watchable);
			if (g.kind === "corte" && measured.length > 0)
				out.push(build(g, mergeEvidence([], measured), context, "single", null, now, stateName));
		}
	}
	return out;
}

/**
 * Each family's short name in running text, one entry per family (whole-release review, M1: a two-way mapping left
 * from a merge called a public camera "Cloudflare Radar"). The type makes a missing family a compile error.
 */
export const FAMILY_NAMES: Readonly<Record<Family, { es: string; en: string }>> = {
	ioda: { es: "IODA", en: "IODA" },
	"ripe-atlas": { es: "RIPE Atlas", en: "RIPE Atlas" },
	cloudflare: { es: "Cloudflare Radar", en: "Cloudflare Radar" },
	viirs: { es: "luces nocturnas de NASA", en: "NASA night lights" },
	usgs: { es: "USGS", en: "USGS" },
	funvisis: { es: "FUNVISIS", en: "FUNVISIS" },
	prensa: { es: "prensa", en: "press" },
	gdacs: { es: "GDACS", en: "GDACS" },
	usuarios: { es: "reportes de usuarios", en: "user reports" },
	camaras: { es: "cámaras públicas", en: "public cameras" },
};

/** Whether the families that can open incidents are all reports (join-only families do not change it). */
function reportsOnlyOf(families: readonly Family[]): boolean {
	const own = families.filter((f) => !JOIN_ONLY.includes(f));
	return own.length > 0 && own.every((f) => REPORT_FAMILIES.includes(f));
}

/** "3 fuentes independientes" / "solo reportes (4 medios)". */
export function corroborationLabel(
	i: Pick<Incident, "corroboration" | "reportsOnly" | "outlets"> &
		Partial<Pick<Incident, "tier" | "families">>,
): {
	es: string;
	en: string;
} {
	const joined = JOIN_ONLY.filter((f) => i.families?.includes(f));
	const joinedEs = joined.map((f) => FAMILY_NAMES[f].es);
	const joinedEn = joined.map((f) => FAMILY_NAMES[f].en);
	if (i.tier === "watch")
		return { es: "señal sin corroborar (1 fuente medida)", en: "uncorroborated signal (1 measured source)" };
	if (i.reportsOnly)
		return {
			es: `solo reportes (${i.outlets} ${i.outlets === 1 ? "medio" : "medios"}${joinedEs.map((j) => ` y ${j}`).join("")}), sin medición que lo confirme`,
			en: `reports only (${i.outlets} ${i.outlets === 1 ? "outlet" : "outlets"}${joinedEn.map((j) => ` and ${j}`).join("")}), no measurement confirms it`,
		};
	return {
		es: `${i.corroboration} fuentes independientes${joined.length ? `, entre ellas ${joinedEs.join(" y ")}` : ""}`,
		en: `${i.corroboration} independent sources${joined.length ? `, ${joinedEn.join(" and ")} among them` : ""}`,
	};
}
