import { expect, test } from "bun:test";
import type { NewsItem } from "../adapters/rss/factory.ts";
import { Store } from "../core/store.ts";
import type { Observation } from "../core/types.ts";
import type { QuakeReading } from "../panels/quakes.ts";
import {
	atlasEvidence,
	type ConnState,
	corteSignals,
	iodaDropEvidence,
	nightEvidence,
	OUTAGE_EXAMPLES,
	outageOf,
	type QuakeInput,
	SIGNAL_RULES,
	type SignalInputs,
	sismoSignals,
	type TaggedHeadline,
	tagHeadlines,
} from "./signals.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 8, 25, 1, 30);

const conn = (partial: Partial<ConnState> = {}): ConnState => ({
	id: "VE-K",
	level: "drop",
	headline: "Caída de señal en sondeo activo",
	lastBinAt: NOW - 20 * MIN,
	sourceUrl: "https://ioda.inetintel.cc.gatech.edu/region/4489",
	signals: [
		{
			signal: "ping-slash24",
			level: "drop",
			pctOfBaseline: 75.6,
			observedAt: NOW - 20 * MIN,
			fetchedAt: NOW - 5 * MIN,
		},
		{
			signal: "bgp",
			level: "normal",
			pctOfBaseline: 100,
			observedAt: NOW - 20 * MIN,
			fetchedAt: NOW - 5 * MIN,
		},
	],
	probes: null,
	...partial,
});

const empty = (): SignalInputs => ({
	connectivity: { states: [], events: [], eventsFetchedAt: null },
	nights: { date: null, observedAt: null, fetchedAt: null, sourceUrl: null, states: [] },
	headlines: [],
	quakes: [],
	hazards: [],
});

const headline = (partial: Partial<TaggedHeadline>): TaggedHeadline => ({
	outlet: "la-prensa-lara",
	outletName: "La Prensa de Lara",
	series: "item:1",
	title: "Apagón en Barquisimeto",
	url: "https://example.org/1",
	at: NOW - HOUR,
	fetchedAt: NOW - 50 * MIN,
	dateMissing: false,
	topics: ["electricidad"],
	outage: "power",
	states: ["VE-K"],
	...partial,
});

test("IODA: only a severe drop is evidence; it names the agreeing signals with their figures and the stored bins", () => {
	expect(SIGNAL_RULES.iodaLevels).toEqual(["severe"]);
	// A plain one-signal drop is not evidence (calibration: 5 false incidents in quiet windows against 2).
	expect(iodaDropEvidence(conn())).toBeNull();
	const severe = (c: ConnState): ConnState => ({
		...c,
		level: "severe",
		signals: c.signals.map((r) => (r.signal === "ping-slash24" ? { ...r, level: "severe" } : r)),
	});
	const e = iodaDropEvidence(severe(conn()));
	expect(e?.es).toBe("IODA: caída fuerte de señal, sondeo activo al 75,6 % de lo normal a esta hora");
	expect(e?.refs).toEqual([
		{ source: "ioda-states", series: "state:VE-K:ping-slash24", observedAt: NOW - 20 * MIN },
	]);
	expect(iodaDropEvidence(conn({ level: "normal" }))).toBeNull();
	expect(iodaDropEvidence(conn({ level: "no-data" }))).toBeNull();
});

test("RIPE Atlas: two or more probes that dropped in the last hour and are still down", () => {
	const p = {
		droppedLastHour: 0,
		disconnected: 2,
		active: 5,
		observedAt: NOW,
		sourceUrl: "https://atlas.ripe.net",
	};
	expect(atlasEvidence("VE-K", p)).toBeNull();
	expect(atlasEvidence("VE-K", { ...p, droppedLastHour: 1 })).toBeNull();
	expect(atlasEvidence("VE-K", { ...p, droppedLastHour: 2 })?.es).toBe(
		"RIPE Atlas: 2 de 5 sondas del estado perdieron la conexión en la última hora",
	);
});

test("night lights: comparable nights at −30 % or lower; cloudy nights never", () => {
	const night = (pctChange: number | null, comparable = true) => ({
		date: "2026-09-23",
		observedAt: NOW - 30 * HOUR,
		fetchedAt: NOW - 2 * HOUR,
		sourceUrl: null,
		states: [{ iso: "VE-K", pctChange, comparable, baselineNights: 9 }],
	});
	expect(nightEvidence(night(-29.9))).toEqual([]);
	expect(nightEvidence(night(-30))).toHaveLength(1);
	expect(nightEvidence(night(-60, false))).toEqual([]);
	expect(nightEvidence(night(null))).toEqual([]);
	expect(nightEvidence(night(-45))[0]?.evidence.es).toBe(
		"NASA VIIRS: luces nocturnas −45,0 % frente a la mediana de 9 noches (noche del 2026-09-23)",
	);
});

test("corte: only dated headlines that report a cut, by state; ISP events and other news are ignored", () => {
	const input = empty();
	input.connectivity = {
		states: [conn({ level: "severe" })],
		events: [
			{
				id: "e1",
				kind: "isp",
				key: "cantv",
				signal: "bgp",
				startAt: NOW - HOUR,
				endAt: NOW,
				durationMin: 60,
				openAtFetch: true,
				url: "u",
			},
			{
				id: "e2",
				kind: "state",
				key: "VE-K",
				signal: "ping-slash24",
				startAt: NOW - 2 * HOUR,
				endAt: NOW - HOUR,
				durationMin: 60,
				openAtFetch: false,
				url: "u",
			},
		],
		eventsFetchedAt: NOW - 10 * MIN,
	};
	input.headlines = [
		headline({}),
		headline({ series: "item:2", topics: ["economia"], outage: null, url: "https://example.org/2" }),
		headline({
			series: "item:3",
			title: "Usuarios reportan caída de internet en Barquisimeto y Maracaibo",
			topics: ["internet"],
			outage: "internet",
			states: ["VE-K", "VE-V"],
			url: "https://example.org/3",
		}),
		// On the internet topic, but it reports no cut (review 3, H3).
		headline({
			series: "item:4",
			title: "Movistar entregó 500 kits escolares en Lara",
			topics: ["internet"],
			outage: null,
			url: "https://example.org/4",
		}),
		// Reports a cut, but the feed gave no date: its time is when Vigía saw it (review 3, H3).
		headline({ series: "item:5", dateMissing: true, url: "https://example.org/5" }),
	];
	const signals = corteSignals(input, NOW);
	expect(signals.map((s) => `${s.key} ${s.evidence.id} ${s.evidence.speaks}`)).toEqual([
		"VE-K ioda:drop:VE-K connectivity",
		"VE-K ioda:event:e2 connectivity",
		"VE-K news:la-prensa-lara:item:1 power",
		"VE-K news:la-prensa-lara:item:3 internet",
		"VE-V news:la-prensa-lara:item:3 internet",
	]);
});

const reading = (label: "USGS" | "FUNVISIS", at: number, mag: number): QuakeReading => ({
	feed: label === "USGS" ? "usgs-quakes" : "funvisis-quakes",
	label,
	series: `${label}-1`,
	at,
	fetchedAt: at + 10 * MIN,
	timePrecisionS: label === "USGS" ? 1 : 60,
	mag,
	magType: label === "USGS" ? "mb" : "Mw",
	depthKm: 12,
	lat: 10.1,
	lon: -69.9,
	sourcePlace: null,
	status: label === "USGS" ? "reviewed" : "official",
	confidence: 1,
	url: `https://example.org/${label}`,
});

const quake = (partial: Partial<QuakeInput> = {}): QuakeInput => ({
	id: "q1",
	at: NOW - 3 * HOUR,
	zone: "venezuela",
	state: "VE-K",
	maxMag: 4.2,
	placeEs: "a 20 km de Carora (Lara)",
	lat: 10.1,
	lon: -69.9,
	usgs: reading("USGS", NOW - 3 * HOUR, 4.2),
	funvisis: reading("FUNVISIS", NOW - 3 * HOUR + 30_000, 4.0),
	...partial,
});

test("sismo: each network, news after the quake naming its state, IODA outages starting within 2 h (not a drop that is merely current)", () => {
	const input = empty();
	const t = NOW - 3 * HOUR;
	input.quakes = [quake(), quake({ id: "small", maxMag: 3.4 }), quake({ id: "far", zone: "far" })];
	input.headlines = [
		headline({ topics: ["sismo"], at: t + 20 * MIN, series: "a" }),
		headline({ topics: ["sismo"], at: t - 20 * MIN, series: "before" }),
		headline({ topics: ["sismo"], at: t + 30 * MIN, series: "other-state", states: ["VE-V"] }),
	];
	input.connectivity = {
		states: [conn({ lastBinAt: NOW - 10 * MIN })],
		events: [
			{
				id: "in",
				kind: "state",
				key: "VE-K",
				signal: "bgp",
				startAt: t + 30 * MIN,
				endAt: t + HOUR,
				durationMin: 30,
				openAtFetch: false,
				url: "u",
			},
			{
				id: "late",
				kind: "state",
				key: "VE-K",
				signal: "bgp",
				startAt: t + 3 * HOUR,
				endAt: NOW,
				durationMin: 30,
				openAtFetch: false,
				url: "u",
			},
		],
		eventsFetchedAt: NOW,
	};
	const signals = sismoSignals(input, NOW);
	expect(new Set(signals.map((s) => s.key))).toEqual(new Set(["USGS-1"]));
	expect(signals.map((s) => s.evidence.id)).toEqual([
		"usgs:USGS-1",
		"funvisis:FUNVISIS-1",
		"news:la-prensa-lara:a",
		"ioda:event:in",
	]);
	expect(signals[0]?.title?.es).toBe("Sismo M4,2 a 20 km de Carora (Lara)");
	expect(signals[0]?.evidence.es).toBe("USGS: M4,2 (mb), 12 km de profundidad, revisado");
});

test("a felt quake in a state is context for that state's cuts, never a signal", () => {
	const input = empty();
	input.quakes = [quake()];
	const signals = corteSignals(input, NOW);
	expect(signals.map((s) => [s.key, s.evidence.role])).toEqual([["VE-K", "context"]]);
});

test("headlines: tagged from the stored items, the topic from the headline only", () => {
	const store = new Store(":memory:");
	const item = (
		outlet: string,
		n: number,
		title: string,
		summary: string,
		at: number,
	): Observation<NewsItem> => ({
		source: outlet,
		series: `item:${n}`,
		sourceUrl: `https://example.org/${n}`,
		fetchedAt: at + MIN,
		observedAt: at,
		licence: "headline",
		value: {
			outlet,
			title,
			link: `https://example.org/${n}`,
			summary,
			image: null,
			dateMissing: false,
			video: false,
		},
		confidence: 1,
		basis: "report",
	});
	store.insert([
		item(
			"la-verdad",
			1,
			"Habitantes de San Jacinto en Maracaibo cacerolean ante constantes apagones",
			"",
			NOW - HOUR,
		),
		item(
			"contrapunto",
			2,
			"Wingo reactiva la ruta Caracas-Medellín",
			"Más conectividad aérea para Caracas",
			NOW - HOUR,
		),
		item("la-verdad", 3, "Apagón en Maracaibo", "", NOW - 30 * HOUR),
	]);
	const tagged = tagHeadlines(store, NOW);
	expect(tagged.map((h) => [h.series, h.topics, h.states]).sort()).toEqual([
		["item:1", ["electricidad"], ["VE-V"]],
		["item:2", [], ["VE-A"]],
	]);
});

test("a report of a cut, not a mention of the power company or of 'conectividad'", () => {
	expect(outageOf("Apagón en Barquisimeto por falla en subestación")).toBe("power");
	expect(outageOf("Maracayeros ya no aguantan los cortes eléctricos")).toBe("power");
	expect(outageOf("Vecinos de Cumaná llevan tres días sin luz")).toBe("power");
	expect(outageOf("Usuarios reportan caída de internet en Maracaibo")).toBe("internet");
	expect(outageOf("Corpoelec instala transformadores en Lara")).toBeNull();
	expect(outageOf("Movistar lanza nuevos planes de fibra óptica")).toBeNull();
	expect(outageOf("CANTV anuncia inversión en conectividad")).toBeNull();
	expect(outageOf("Gobierno evalúa el sistema eléctrico nacional")).toBeNull();
	expect(outageOf("Wingo reactiva la ruta Caracas-Medellín")).toBeNull();
});

test("the rule text's examples are what the matcher matches", () => {
	for (const example of OUTAGE_EXAMPLES.es)
		expect(outageOf(`Vecinos de Lara reportan ${example}`)).not.toBeNull();
	for (const name of OUTAGE_EXAMPLES.notEnough)
		expect(outageOf(`${name} anuncia inversiones en Lara`)).toBeNull();
	expect(OUTAGE_EXAMPLES.en).toHaveLength(OUTAGE_EXAMPLES.es.length);
});
