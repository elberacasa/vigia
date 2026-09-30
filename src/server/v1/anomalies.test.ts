import { expect, test } from "bun:test";
import type { z } from "zod";
import { ADAPTERS } from "../../adapters/registry.ts";
import type { KeyStore } from "../../config/keys.ts";
import { Scheduler } from "../../core/scheduler.ts";
import { Store } from "../../core/store.ts";
import type { HttpLike, Observation } from "../../core/types.ts";
import { caracasDay, caracasDayStart } from "../../intel/anomaly.ts";
import type { AnomaliesView, AnomalyItem, EntityView } from "../../ontology/view.ts";
import { createApp } from "../app.ts";
import { PANELS } from "../panel-registry.ts";
import { PanelCache } from "../panels.ts";
import * as S from "./schemas.ts";

const NOW = Date.UTC(2026, 8, 28, 22);
const DAY = 86_400_000;
const TODAY = caracasDayStart(caracasDay(NOW));

// The client's types and the published schema describe the same shapes.
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Envelope = { apiVersion: "1"; generatedAt: number };
const sameItem: Mutual<z.infer<typeof S.AnomalyItem>, AnomalyItem> = true;
const sameList: Mutual<z.infer<typeof S.AnomaliesResponse>, Envelope & AnomaliesView> = true;

function setup() {
	const store = new Store(":memory:");
	const rows: Observation[] = [];
	let v = 700;
	for (let d = 90; d >= 1; d--) {
		v *= 1.002;
		const at = TODAY - d * DAY;
		rows.push({
			source: "bcv-history",
			series: "usd-ves",
			sourceUrl: "https://www.bcv.org.ve/",
			fetchedAt: at + 60_000,
			observedAt: at,
			licence: "bcv",
			value: { valueDate: new Date(at).toISOString().slice(0, 10), vesPerUsd: v },
			confidence: 1,
			basis: "official",
		});
	}
	rows.push({
		source: "bcv-official",
		series: "usd-ves",
		sourceUrl: "https://www.bcv.org.ve/",
		fetchedAt: TODAY + 60_000,
		observedAt: TODAY,
		licence: "bcv",
		value: { currency: "USD", valueDate: new Date(TODAY).toISOString().slice(0, 10), vesPerUnit: v * 1.08 },
		confidence: 1,
		basis: "official",
	});
	store.insert(rows);
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
	const now = () => NOW;
	const app = createApp({
		store,
		scheduler: new Scheduler(ADAPTERS, { store, http, key: () => undefined, now }),
		adapters: ADAPTERS,
		keys,
		keySpecs: [],
		panels: new PanelCache(PANELS, store, now),
		http,
		version: "test",
		sessionToken: "ab".repeat(32),
		now,
		setFeedEnabled: () => {},
	});
	const get = (path: string) =>
		app.fetch(
			new Request(`http://localhost:7722${path}`, { headers: { host: "localhost:7722" } }),
			"127.0.0.1",
		);
	return { app, get };
}

test("the anomalies route: the documented shape, filters, and the entity page's block", async () => {
	expect([sameItem, sameList]).toEqual([true, true]);
	const { get, app } = setup();
	await app.syncLinks();
	const res = await get("/api/v1/anomalies");
	expect(res.status).toBe(200);
	const body = (await res.json()) as AnomaliesView;
	expect(S.AnomaliesResponse.parse(body)).toEqual(body as never);
	expect(body.items.map((i) => [i.metric.id, i.entity.id, i.direction])).toEqual([
		["bcv.usd", "inst.bcv", "up"],
	]);
	expect(body.items[0]?.rule.es).toContain("cambios diarios");
	// Filters: by entity (inside it counts), by class, by score, by explanation.
	for (const [q, n] of [
		["entity=inst.bcv", 1],
		["entity=ve", 1],
		["entity=ve.zulia", 0],
		["class=change", 1],
		["class=count", 0],
		["minScore=1000", 0],
		["explained=1", 0],
		["explained=0", 1],
	] as const) {
		const r = (await (await get(`/api/v1/anomalies?${q}`)).json()) as AnomaliesView;
		expect(r.items.length, q).toBe(n);
	}
	for (const [q, status] of [
		["entity=ve.narnia", 404],
		["class=gossip", 400],
		["minScore=-1", 400],
		["minScore=abc", 400],
		["explained=2", 400],
		["limit=x", 400],
	] as const)
		expect((await get(`/api/v1/anomalies?${q}`)).status, q).toBe(status);
	// The institution's page carries the same reading; a place without one carries none.
	const bcv = (await (await get("/api/v1/entities/inst.bcv")).json()) as EntityView;
	expect(bcv.anomalies.map((a) => a.metric.id)).toEqual(["bcv.usd"]);
	expect(S.EntityResponse.parse(bcv)).toEqual(bcv as never);
	const zulia = (await (await get("/api/v1/entities/ve.zulia")).json()) as EntityView;
	expect(zulia.anomalies).toEqual([]);
});
