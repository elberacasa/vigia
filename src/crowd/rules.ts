/**
 * Crowd reports ("¿Tienes luz, agua, internet, gasolina?"): the rules as constants, and the words the UI and the API
 * show, generated from them, so the published rule and the code cannot drift apart (the same pattern as
 * src/intel/incidents.ts). Every threshold here is tested against the attacks it is meant to stop
 * (service.test.ts).
 *
 * What a report is: one municipality (an entity id from the registry), one service, one answer, stored as a count in
 * a 15-minute bucket. Nothing else about the person or the device is ever written anywhere (SECURITY.md, "Crowd
 * reports").
 */

import type { Licence } from "../core/types.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The Vigía-own source the aggregated counts are stored under (observations, like "vigia-incidents"). */
export const CROWD_SOURCE = "vigia-crowd";

export const CROWD_LICENCE: Licence = {
	id: "cc0-vigia-crowd",
	name: "CC0 1.0 (dominio público)",
	url: "https://creativecommons.org/publicdomain/zero/1.0/",
	attribution: "Reportes anónimos de usuarios de esta instancia de Vigía",
	commercial: true,
};

export const SERVICES = ["luz", "agua", "internet", "gasolina"] as const;
export type Service = (typeof SERVICES)[number];

export const ANSWERS = ["si", "no", "intermitente"] as const;
export type Answer = (typeof ANSWERS)[number];

export type CrowdMode = "local" | "public";

export const SERVICE_TEXT: Record<
	Service,
	{ es: string; en: string; question: { es: string; en: string }; without: { es: string; en: string } }
> = {
	luz: {
		es: "luz",
		en: "power",
		question: { es: "¿Tienes luz ahora?", en: "Do you have power now?" },
		without: { es: "sin luz", en: "without power" },
	},
	agua: {
		es: "agua",
		en: "water",
		question: { es: "¿Tienes agua ahora?", en: "Do you have running water now?" },
		without: { es: "sin agua", en: "without water" },
	},
	internet: {
		es: "internet",
		en: "internet",
		question: { es: "¿Tienes internet ahora?", en: "Do you have internet now?" },
		without: { es: "sin internet", en: "without internet" },
	},
	gasolina: {
		es: "gasolina (o gas)",
		en: "fuel (petrol or gas)",
		question: { es: "¿Tienes gasolina (o gas) ahora?", en: "Can you get petrol (or gas) now?" },
		without: { es: "sin gasolina ni gas", en: "without fuel" },
	},
};

export const ANSWER_TEXT: Record<Answer, { es: string; en: string }> = {
	si: { es: "sí", en: "yes" },
	no: { es: "no", en: "no" },
	intermitente: { es: "intermitente", en: "on and off" },
};

export const CROWD_RULES = {
	/** Reports are stored as counts per 15-minute bucket: the only time kept. */
	bucketMs: 15 * MIN,
	/** "Ahora": the reports of the last two hours. */
	windowMs: 2 * HOUR,
	/**
	 * Distinct reporters (one per connection) a municipality and service needs before its counts are shown. On a
	 * public mirror a count below this is never published (it could point at one household); on a person's own Vigía
	 * the reporters are the household, so one is enough.
	 */
	minReporters: { public: 3, local: 1 } satisfies Record<CrowdMode, number>,
	/**
	 * Of those, distinct connections (addresses): a public figure never rests on one address, however many phones
	 * behind it sent a device token.
	 */
	minConnections: { public: 2, local: 1 } satisfies Record<CrowdMode, number>,
	/**
	 * A public mirror publishes the counts only when each 15-minute bucket closes, never the open one, so a figure
	 * does not change the moment someone was seen sending a report (the bucket coarsens the timing; with little
	 * traffic a change can still be matched with the reports of that quarter hour). A person's own Vigía shows them
	 * at once, unless it serves the local network (`--host 0.0.0.0`): then it waits for the bucket too.
	 */
	publishOpenBucket: { public: false, local: true } satisfies Record<CrowdMode, boolean>,
	/**
	 * One connection's reports: repeats within the window update the earlier answer instead of adding. Phones behind
	 * one carrier NAT address that send a device token count as different reporters, at most `devicesPerPair` per
	 * municipality and service at a time; every limit here stays on the address, whatever the tokens.
	 */
	perClient: {
		/**
		 * Live reporters one address may have per municipality and service. A model of carrier NAT (a Poisson number of
		 * reporters among the subscribers sharing one address; SECURITY.md, crowd reports): at 64 subscribers per address and 2 % of them
		 * reporting the same municipality and service within two hours, 4 loses under 1 % of genuine reporters.
		 */
		devicesPerPair: 4,
		/** Submissions at once, then this many per hour (each submission may answer all four services). */
		burst: 8,
		perHour: 30,
		/** Different municipalities one connection may report on per day (home, work, family). */
		maxMunicipalitiesPerDay: 6,
		/** Challenges handed out at once, then this many per hour. */
		challengeBurst: 12,
		challengesPerHour: 60,
		/** Every connection of one IPv6 /48 together (a site holds 65,536 /64s). */
		site48Burst: 40,
		site48PerHour: 300,
	},
	/**
	 * Flood detection per municipality, service and ANSWER, over the last hour (the open 15-minute bucket and the
	 * three before it). Only new reports count (a repeat that moves an earlier answer does not), and each answer has
	 * its own ceiling, so a flood of «sí» never holds a genuine «no». A report beyond its answer's ceiling is held:
	 * shown as "posible manipulación", never counted. The ceiling is the largest of: a floor, a multiple of the
	 * municipality's usual busiest hour (the median of each day's busiest hour over the last 14 days, so a few days
	 * of attack cannot ratchet it up quickly), and one report per so many inhabitants (so a first real blackout in a
	 * big city, with no history yet, is not held).
	 */
	flood: {
		windowMs: HOUR,
		floorPerHour: 30,
		historyMultiplier: 4,
		historyDays: 14,
		inhabitantsPerReport: 2_500,
	},
	/**
	 * New reports accepted per minute: per state, so a flood in one state never stops the others, and for the whole
	 * instance (its resources); past either, refused for a moment. Checked before the proof of work is spent.
	 */
	load: { perStatePerMinute: 200, globalPerMinute: 1_000 },
	/**
	 * Proof of work: SHA-256 of the challenge and a counter must start with this many zero bits. Moments for one
	 * phone (measured in docs/PERF.md); a small price per report for a script, which it multiplies, but no wall
	 * against someone with many addresses and native code or a GPU. It gets `underLoadExtra` bits harder (each bit
	 * doubles it) for the next 15-minute bucket when the last bucket averaged more than `loadPerMinute` new reports a
	 * minute; it never changes within a bucket, so it tells nobody when a single report arrived.
	 */
	pow: {
		difficulty: { public: 18, local: 12 } satisfies Record<CrowdMode, number>,
		underLoadExtra: 2,
		loadPerMinute: 120,
		ttlMs: 10 * MIN,
	},
	/**
	 * Incidents: a municipality's reports are evidence of a cut ("usuarios", their own family) when at least this
	 * many connections answered "no" or "intermitente" for power or internet in the window and none of its reports
	 * were held. They corroborate; they never open an incident alone (src/intel/incidents.ts).
	 */
	incident: {
		minOutageReports: { public: 5, local: 1 } satisfies Record<CrowdMode, number>,
		/** …from at least this many distinct connections (phones behind one address count once here). */
		minOutageConnections: { public: 3, local: 1 } satisfies Record<CrowdMode, number>,
		speaks: { luz: "power", internet: "internet" } as const,
	},
	/**
	 * Bucket counts are kept this long (the flood baseline reads 14 days); after a day they keep only hourly totals
	 * with no answer. The published aggregates follow the archive.
	 */
	retentionDays: 30,
	/** Aggregates are re-published at every bucket boundary; older than this (plus slack) they are stale. */
	staleAfterMs: 15 * MIN + 5 * MIN,
	/** The only fields a report may carry: bounded body. */
	maxBodyBytes: 2_048,
	/** Abuse-control memory: a new random salt every day; the previous one is kept only until its entries expire. */
	saltRotationMs: DAY,
	/** In-memory entries tracked at most (per map); past it the oldest are forgotten. */
	maxTracked: 100_000,
} as const;

/** The minimum a view uses, by mode. */
export function minReporters(mode: CrowdMode): number {
	return CROWD_RULES.minReporters[mode];
}

const hours = (ms: number) => Math.round(ms / HOUR);
const minutes = (ms: number) => Math.round(ms / MIN);

/** The rules in words, generated from CROWD_RULES, for this instance's mode. */
export function crowdRulesText(mode: CrowdMode): { es: string[]; en: string[] } {
	const r = CROWD_RULES;
	const c = r.perClient;
	const f = r.flood;
	const min = r.minReporters[mode];
	const open = r.publishOpenBucket[mode];
	return {
		es: [
			"Reportes de usuarios: personas que respondieron «¿tienes luz, agua, internet, gasolina (o gas) ahora?» para un municipio. No son una medición: son reportes, sin verificar, con su cantidad y su hora.",
			`Se muestran los de las últimas ${hours(r.windowMs)} h, contados por municipio y por estado. Cada reportante (una conexión, o un teléfono detrás de ella con su identificador aleatorio) cuenta una vez por municipio y servicio: si responde de nuevo, su respuesta anterior se reemplaza.`,
			mode === "public"
				? `Un municipio y servicio se muestra solo con al menos ${min} reportes de al menos ${r.minConnections.public} conexiones distintas; con menos no se publica nada, ni en la suma del estado (que solo suma los municipios que se muestran). Las cifras se publican al cerrar cada bloque de ${minutes(r.bucketMs)} min, nunca el bloque en curso.`
				: `En este Vigía propio basta ${min === 1 ? "un reporte" : `${min} reportes`}: son los de tu hogar.${open ? " Se ven al momento (si sirve a la red local, al cerrar cada bloque de 15 min)." : ""}`,
			`Límites por conexión: ${c.burst} envíos seguidos y luego ${c.perHour} por hora; como máximo ${c.maxMunicipalitiesPerDay} municipios distintos por día. Varias personas detrás de una misma dirección (datos móviles) comparten estos límites; si su página envía un identificador aleatorio del teléfono, cuentan por separado, hasta ${c.devicesPerPair} por municipio y servicio a la vez (sin él, cuentan como una). Cada envío resuelve primero una prueba de trabajo: unos instantes en un teléfono, un costo pequeño por reporte que no detiene a quien tiene muchas direcciones.`,
			`Ráfagas: en la última hora, cada respuesta de un municipio y servicio cuenta como máximo lo mayor entre ${f.floorPerHour} reportes nuevos, ${f.historyMultiplier} veces su hora más activa habitual (mediana de las horas pico de ${f.historyDays} días) y un reporte por cada ${f.inhabitantsPerReport.toLocaleString("es-VE")} habitantes. Lo que pasa de ahí se retiene, se muestra como «posible manipulación» y no se cuenta. Cada respuesta tiene su propio techo: muchos «sí» nunca retienen un «no».`,
			"Qué se guarda: el municipio, el servicio, la respuesta y un bloque de 15 minutos, como conteos. Nunca la dirección IP, el navegador, el identificador del teléfono, cookies ni coordenadas. Lo que sirve para frenar abusos (y la huella del identificador del teléfono) vive solo en memoria, bajo una huella con sal que cambia cada día, y se borra al vencer.",
			"Los reportes de usuarios nunca abren ni confirman un incidente: se suman como corroboración a uno que ya abrieron otras fuentes.",
		],
		en: [
			'User reports: people who answered "do you have power, water, internet, fuel now?" for a municipality. They are not a measurement: they are unverified reports, with their count and time.',
			`Shown for the last ${hours(r.windowMs)} h, counted per municipality and per state. Each reporter (a connection, or a phone behind it with its random token) counts once per municipality and service: answering again replaces its earlier answer.`,
			mode === "public"
				? `A municipality and service is shown only with at least ${min} reports from at least ${r.minConnections.public} different connections; with fewer, nothing is published, not even in the state's sum (which adds only the municipalities shown). Figures are published as each ${minutes(r.bucketMs)}-min block closes, never the open block.`
				: `On your own Vigía ${min === 1 ? "one report is" : `${min} reports are`} enough: they are your household's.${open ? " They show at once (when it serves the local network, as each 15-min block closes)." : ""}`,
			`Per-connection limits: ${c.burst} submissions in a row, then ${c.perHour} per hour; at most ${c.maxMunicipalitiesPerDay} different municipalities per day. Several people behind one address (mobile data) share these limits; if their page sends a random phone token, they count separately, up to ${c.devicesPerPair} per municipality and service at a time (without it, as one). Each submission first solves a proof of work: moments on a phone, a small price per report that does not stop someone with many addresses.`,
			`Bursts: within the last hour, each answer for a municipality and service counts at most the largest of ${f.floorPerHour} new reports, ${f.historyMultiplier} times its usual busiest hour (median of the daily peak hours over ${f.historyDays} days) and one report per ${f.inhabitantsPerReport.toLocaleString("en-US")} inhabitants. Anything beyond is held, shown as "possible manipulation" and not counted. Each answer has its own ceiling: many "yes" never hold a "no".`,
			"What is stored: the municipality, the service, the answer and a 15-minute block, as counts. Never the IP address, the browser, the phone's token, cookies or coordinates. What is used to stop abuse (and the phone token's fingerprint) lives only in memory, under a salted fingerprint that changes every day, and is dropped when it expires.",
			"User reports never open or confirm an incident: they join, as corroboration, one that other sources already opened.",
		],
	};
}

/** Exactly what is stored, for the API and the privacy notes (kept next to the constants it describes). */
export function storedText(): { es: string[]; en: string[] } {
	const b = minutes(CROWD_RULES.bucketMs);
	return {
		es: [
			`En disco (tabla crowd_counts): municipio, servicio, respuesta, el inicio del bloque de ${b} min, y tres conteos (contados, retenidos, y de los contados cuántos vinieron de una dirección que ya tenía otro teléfono reportando); pasado un día quedan solo totales por hora, sin respuesta, y se borran a los ${CROWD_RULES.retentionDays} días. En crowd_arrivals, los reportes nuevos por municipio, servicio, respuesta y bloque, dos horas.`,
			`En el archivo (fuente ${CROWD_SOURCE}): los agregados publicados por municipio y estado (conteos por respuesta, retenidos, la ventana y la hora de publicación), como cualquier otra observación.`,
			"Solo en memoria, nunca en disco ni en registros: una huella HMAC-SHA-256 de la conexión con una sal aleatoria que cambia cada día, con lo que esa conexión respondió en la ventana (para reemplazar en vez de sumar), los municipios del día y sus límites; la huella, con la misma sal, del identificador aleatorio del teléfono si la página lo envía (nunca el identificador tal cual), solo mientras vive su respuesta; y los desafíos ya usados. Todo se descarta al vencer su ventana o al cambiar la sal.",
			"Nunca: dirección IP, navegador (User-Agent), el identificador del teléfono ni nada del equipo, cookies, coordenadas, ni la hora exacta del reporte.",
		],
		en: [
			`On disk (table crowd_counts): municipality, service, answer, the start of the ${b}-min block, and three counts (counted, held, and of the counted how many came from an address that already had another phone reporting); after a day only hourly totals remain, with no answer, deleted after ${CROWD_RULES.retentionDays} days. In crowd_arrivals, new reports per municipality, service, answer and block, for two hours.`,
			`In the archive (source ${CROWD_SOURCE}): the published aggregates per municipality and state (counts per answer, held, the window and the publication time), like any other observation.`,
			"Only in memory, never on disk or in logs: an HMAC-SHA-256 fingerprint of the connection under a random salt that changes every day, with what that connection answered in the window (to replace rather than add), the day's municipalities and its limits; the fingerprint, under the same salt, of the phone's random token if the page sends one (never the token as sent), only while its answer lives; and the challenges already used. All of it is dropped when its window ends or the salt changes.",
			"Never: IP address, browser (User-Agent), the phone's token or anything about the device, cookies, coordinates, or the exact time of the report.",
		],
	};
}
