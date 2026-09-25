import { expect, test } from "bun:test";
import { tickerEvents } from "./ticker.ts";

const H = 3_600_000;
const NOW = 1_790_300_000_000;

const panels = {
	quakes: {
		items: [
			{
				id: "q1",
				at: NOW - 2 * H,
				zone: "venezuela",
				state: "VE-R",
				placeEs: "a 13 km al O de Irapa (Sucre)",
				maxMag: 3.6,
				usgs: null,
				funvisis: { url: "http://www.funvisis.gob.ve/" },
			},
			{
				id: "far",
				at: NOW - H,
				zone: "far",
				state: null,
				placeEs: "Colombia",
				maxMag: 5,
				usgs: null,
				funvisis: null,
			},
		],
	},
	connectivity: {
		events: [
			{
				id: "e1",
				kind: "state",
				key: "VE-K",
				name: "Lara",
				startAt: NOW - 3 * H,
				endAt: NOW - 90 * 60_000,
				durationMin: 90,
				openAtFetch: false,
				url: "https://ioda.example/1",
			},
			{
				id: "e2",
				kind: "state",
				key: "VE-U",
				name: "Yaracuy",
				startAt: NOW - 10 * 60_000,
				endAt: NOW,
				durationMin: 10,
				openAtFetch: true,
				url: "https://ioda.example/2",
			},
		],
	},
	money: {
		official: {
			usd: {
				// Read from the history file after it took effect: not a publication event.
				current: {
					vesPerUnit: 853.5,
					valueDate: "2026-09-23",
					validFrom: NOW - 20 * H,
					fetchedAt: NOW - H,
					sourceUrl: "",
				},
				// Seen before its value date: published at fetchedAt.
				next: {
					vesPerUnit: 855.6625,
					valueDate: "2026-09-25",
					validFrom: NOW + 3 * H,
					fetchedAt: NOW - 30 * 60_000,
					sourceUrl: "",
				},
			},
		},
	},
	hazards: {
		gdacs: {
			events: [
				{
					id: "eq",
					eventType: "EQ",
					typeEs: "Sismo",
					name: "",
					alertLevel: "green",
					fromAt: NOW - H,
					stateName: "Lara",
					url: "",
				},
				{
					id: "tc",
					eventType: "TC",
					typeEs: "Ciclón",
					name: "Storm",
					alertLevel: "orange",
					fromAt: NOW - 5 * H,
					stateName: null,
					url: "",
				},
			],
		},
	},
	censorship: {
		timeline: {
			changes: [
				{
					source: "vesinfiltro",
					kind: "blocked",
					domain: "x.org",
					isp: "cantv",
					after: NOW - 9 * H,
					by: NOW - 4 * H,
					url: "",
				},
			],
		},
	},
};

test("events from every panel, oldest to newest, with their source time", () => {
	const events = tickerEvents(panels, NOW, "es");
	expect(events.map((e) => e.text)).toEqual([
		"Ciclón · alerta naranja",
		"Bloqueo · x.org · cantv",
		"Caída de señal · Lara",
		"Sismo M3,6 · a 13 km al O de Irapa (Sucre)",
		"Fin de la caída · Lara · 90 min",
		"Dólar BCV 855,66 Bs para el 25 sept",
		"Caída de señal · Yaracuy",
	]);
	expect(events.find((e) => e.kind === "quake")?.state).toBe("VE-R");
	expect(events.find((e) => e.kind === "rate")?.at).toBe(NOW - 30 * 60_000);
});

test("keeps only the newest `limit`", () => {
	const events = tickerEvents(panels, NOW, "en", 2);
	expect(events.map((e) => e.kind)).toEqual(["rate", "outage"]);
	expect(events[0]?.text).toBe("BCV dollar 855.66 Bs for Sep 25");
});

test("no panels, no events", () => {
	expect(tickerEvents({}, NOW, "es")).toEqual([]);
});
