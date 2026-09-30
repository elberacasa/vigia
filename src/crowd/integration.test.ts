import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { ADAPTERS } from "../adapters/registry.ts";
import type { KeyStore } from "../config/keys.ts";
import { Scheduler } from "../core/scheduler.ts";
import { Store } from "../core/store.ts";
import type { HttpLike } from "../core/types.ts";
import { corteSignals, crowdEvidence } from "../intel/signals.ts";
import { linker } from "../ontology/linker.ts";
import type { NowItem, TimelineItem } from "../ontology/view.ts";
import { type CrowdItem, crowdView } from "../panels/crowd.ts";
import { incidentsView, signalInputs } from "../panels/incidents.ts";
import { createApp } from "../server/app.ts";
import { PANELS } from "../server/panel-registry.ts";
import { PanelCache } from "../server/panels.ts";
import * as S from "../server/v1/schemas.ts";
import { solve } from "./pow-solve.ts";
import { CROWD_RULES, CROWD_SOURCE } from "./rules.ts";
import { aggregateObservation, CrowdService } from "./service.ts";

const T0 = Date.UTC(2026, 8, 28, 12, 1);
const MARACAIBO = "ve.zulia.maracaibo";
const ip = (i: number) => `198.51.100.${i + 1}`;

function setup() {
	const clock = { now: T0 };
	const now = () => clock.now;
	const store = new Store(":memory:");
	const http: HttpLike = {
		request: async () => {
			throw new Error("offline");
		},
	};
	const keys: KeyStore = {
		get: () => undefined,
		has: () => false,
		set: () => {},
		remove: () => {},
		origin: () => null,
	};
	const panels = new PanelCache(PANELS, store, now);
	const crowd = new CrowdService({
		store,
		mode: "public",
		enabled: true,
		now,
		powBits: 2,
		onInserted: () => panels.invalidate(CROWD_SOURCE),
	});
	const app = createApp({
		store,
		scheduler: new Scheduler(ADAPTERS, { store, http, key: () => undefined, now }),
		adapters: ADAPTERS,
		keys,
		keySpecs: [],
		panels,
		http,
		version: "test",
		sessionToken: "ab".repeat(32),
		now,
		deploy: { mode: "public" },
		crowd,
	});
	const report = (from: string, municipality: string, answers: Record<string, string>) => {
		const c = crowd.challenge(from);
		if (!c.ok) throw new Error(c.error);
		const ch = c.challenge as { challenge: string; difficulty: number };
		return crowd.submit(
			{ municipality, answers, challenge: ch.challenge, nonce: solve(ch.challenge, ch.difficulty)?.nonce },
			from,
		);
	};
	const get = (path: string) =>
		app.fetch(
			new Request(`http://vigia.example.org${path}`, { headers: { host: "vigia.example.org" } }),
			"8.8.8.8",
		);
	return { store, crowd, app, report, clock, get, panels };
}

function conforms(schema: z.ZodType, body: unknown): void {
	expect(schema.parse(body)).toEqual(body as never);
}

describe("crowd reports in the entity pages, the timeline and the public API", () => {
	test("a municipality's and its state's 'now' show user reports, labelled as reports; the timeline has them", async () => {
		const { report, crowd, clock, get, app } = setup();
		for (let i = 0; i < 6; i++) report(ip(i), MARACAIBO, { luz: i < 5 ? "no" : "si", agua: "si" });
		clock.now += CROWD_RULES.bucketMs;
		crowd.snapshot();
		await app.syncLinks();

		const muni = await (await get(`/api/v1/entities/${MARACAIBO}`)).json();
		conforms(S.EntityResponse, muni);
		const items = (muni as { now: NowItem[] }).now.filter((n) => n.layer === "crowd");
		expect(items.map((n) => n.label.es)).toEqual(["Reportes de usuarios: agua", "Reportes de usuarios: luz"]);
		const luz = items[1];
		expect(luz).toMatchObject({
			basis: "report",
			computed: true,
			stale: false,
			scope: { id: MARACAIBO },
			source: { feed: CROWD_SOURCE, licence: "cc0-vigia-crowd" },
			figures: { reports: 6, no: 5, si: 1, intermitente: 0, held: 0, flagged: false },
		});
		expect(luz?.text.es).toBe("6 reportes en 2 h: 5 «no», 0 «intermitente», 1 «sí»");

		const state = (await (await get("/api/v1/entities/ve.zulia")).json()) as { now: NowItem[] };
		expect(state.now.filter((n) => n.layer === "crowd").map((n) => n.scope.id)).toEqual([
			"ve.zulia",
			"ve.zulia",
		]);
		// The country is never linked, and shows no crowd figure.
		const country = (await (await get("/api/v1/entities/ve")).json()) as { now: NowItem[] };
		expect(country.now.some((n) => n.layer === "crowd")).toBe(false);

		const timeline = await (await get(`/api/v1/entities/${MARACAIBO}/timeline?kinds=crowd`)).json();
		conforms(S.TimelineResponse, timeline);
		const t = (timeline as { items: TimelineItem[] }).items;
		expect(t.map((i) => i.kind)).toEqual(["crowd", "crowd"]);
		expect(t.find((i) => i.figures?.service === "luz")?.title.es).toBe(
			"Reportes de usuarios: luz: 6 reportes en 2 h: 5 «no», 0 «intermitente», 1 «sí»",
		);

		const panel = (await (await get("/api/v1/panels/crowd")).json()) as { panel?: unknown; data?: unknown };
		expect(JSON.stringify(panel)).toContain(MARACAIBO);
	});

	test("the linker: a published aggregate links its own municipality or state, a tombstone nothing", () => {
		const { crowd, report, clock, store } = setup();
		for (let i = 0; i < 3; i++) report(ip(i), MARACAIBO, { internet: "no" });
		clock.now += CROWD_RULES.bucketMs;
		crowd.snapshot();
		const rows = store.latestPerSeries(CROWD_SOURCE, 0, 100);
		const links = rows.map((o) => linker().observation(o));
		expect(links).toContainEqual([{ entity: MARACAIBO, rule: "reported", confidence: 1 }]);
		expect(links).toContainEqual([{ entity: "ve.zulia", rule: "reported", confidence: 1 }]);
		const tomb = linker().observation({
			source: CROWD_SOURCE,
			series: `muni:${MARACAIBO}:internet:fin`,
			value: { level: "municipality", entity: MARACAIBO, service: "internet", shown: false },
		});
		expect(tomb).toEqual([]);
	});
});

describe("crowd reports in incidents", () => {
	test("reports reach the correlator as evidence for their state; alone they make no incident and no watch", () => {
		const { report, crowd, clock, store, panels } = setup();
		for (let i = 0; i < 5; i++) report(ip(i), MARACAIBO, { luz: "no" });
		clock.now += CROWD_RULES.bucketMs;
		crowd.snapshot();
		const input = signalInputs(store, clock.now, (id) => panels.get(id));
		expect(input.crowd?.map((c) => c.entity)).toContain(MARACAIBO);
		const users = corteSignals(input, clock.now).filter((s) => s.evidence.family === "usuarios");
		expect(users).toHaveLength(1);
		expect(users[0]).toMatchObject({ key: "VE-V", evidence: { speaks: "power", feed: CROWD_SOURCE } });
		expect(users[0]?.evidence.es).toBe(
			"Reportes de usuarios: 5 de 5 reportes sin luz o con servicio intermitente en Maracaibo, de 5 conexiones (5 «no», 0 «intermitente»; últimas 2 h)",
		);
		const view = incidentsView(store, clock.now, (id) => panels.get(id));
		expect(view.incidents).toEqual([]);
		expect(view.watches).toEqual([]);
	});

	test("evidence needs 5 outage answers on a public mirror, power or internet, no held reports, and a live publisher", () => {
		const { crowd, report, clock, store } = setup();
		for (let i = 0; i < 4; i++) report(ip(i), MARACAIBO, { luz: "intermitente", agua: "no" });
		clock.now += CROWD_RULES.bucketMs;
		crowd.snapshot();
		const v = crowdView(store, clock.now);
		const luz = v.municipalities.find((m) => m.service === "luz") as CrowdItem;
		const agua = v.municipalities.find((m) => m.service === "agua") as CrowdItem;
		expect(crowdEvidence(luz)).toBeNull(); // 4 < 5
		expect(
			crowdEvidence({ ...luz, outage: { count: 5, connections: 5, firstAt: 0, lastAt: 1 } })?.family,
		).toBe("usuarios");
		expect(
			crowdEvidence({ ...agua, outage: { count: 9, connections: 9, firstAt: 0, lastAt: 1 } }),
		).toBeNull(); // water: no incident kind
		expect(
			crowdEvidence({
				...luz,
				outage: { count: 9, connections: 9, firstAt: 0, lastAt: 1 },
				heldAnswers: { si: 0, no: 1, intermitente: 0 },
			}),
		).toBeNull();
		// Held «sí» (a flood to hide the blackout) does not remove the evidence.
		expect(
			crowdEvidence({
				...luz,
				outage: { count: 9, connections: 9, firstAt: 0, lastAt: 1 },
				heldAnswers: { si: 40, no: 0, intermitente: 0 },
			})?.family,
		).toBe("usuarios");
		expect(
			crowdEvidence({ ...luz, outage: { count: 9, connections: 9, firstAt: 0, lastAt: 1 }, stale: true }),
		).toBeNull();
		const state = v.states.find((s) => s.service === "luz") as CrowdItem;
		expect(
			crowdEvidence({ ...state, outage: { count: 9, connections: 9, firstAt: 0, lastAt: 1 } }),
		).toBeNull();
	});

	test("a published aggregate is an ordinary CC0 observation (history, hash chain, API)", () => {
		const { store } = setup();
		const o = aggregateObservation(
			{
				level: "municipality",
				entity: MARACAIBO,
				state: "VE-V",
				service: "luz",
				shown: true,
				reports: 3,
				answers: { si: 1, no: 2, intermitente: 0 },
				held: 0,
				heldAnswers: { si: 0, no: 0, intermitente: 0 },
				connections: 3,
				flagged: false,
				belowMinimum: false,
				municipalities: 1,
				outage: { count: 2, connections: 2, firstAt: T0, lastAt: T0 + 900_000 },
				windowFrom: T0 - 7_200_000,
				windowTo: T0,
				windowMs: 7_200_000,
				minReporters: 3,
				minConnections: 2,
				incidentMin: 5,
				incidentMinConnections: 3,
				mode: "public",
			},
			T0,
			T0,
		);
		expect(store.insert([o])).toBe(1);
		expect(o).toMatchObject({ licence: "cc0-vigia-crowd", basis: "report", confidence: 1 });
	});
});
