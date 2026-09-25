import { expect, test } from "bun:test";
import { DAHITI_LICENCE, GURI_SERIES } from "../../adapters/dahiti-guri/index.ts";
import { GACETA_LICENCE } from "../../adapters/gaceta-oficial/index.ts";
import { ADAPTERS } from "../../adapters/registry.ts";
import type { KeyStore } from "../../config/keys.ts";
import { Scheduler } from "../../core/scheduler.ts";
import { Store } from "../../core/store.ts";
import type { HttpLike } from "../../core/types.ts";
import { createApp } from "../app.ts";
import { PanelCache } from "../panels.ts";

// Review 4 M5 (DAHITI: registration-gated, non-commercial) and H1 (the Gaceta rows: only the panel's view is
// served): their stored rows are never handed out by the raw feed routes or /api/v1.
test("DAHITI and Gaceta rows are not downloadable: raw feed routes and /api/v1 series answer 403", async () => {
	expect(DAHITI_LICENCE.raw).toBe(false);
	expect(GACETA_LICENCE.raw).toBe(false);
	const now = () => Date.UTC(2026, 8, 25, 12);
	const store = new Store(":memory:");
	store.insert([
		{
			source: "dahiti-guri",
			series: GURI_SERIES,
			sourceUrl: "https://dahiti.dgfi.tum.de/en/67/water-level-altimetry/",
			fetchedAt: now() - 1_000,
			observedAt: now() - 86_400_000,
			licence: DAHITI_LICENCE.id,
			value: { m: 270.1 },
			confidence: 1,
			basis: "measurement",
		},
	]);
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
	const adapters = ADAPTERS.filter((a) => a.id === "dahiti-guri" || a.id === "gaceta-oficial");
	expect(adapters).toHaveLength(2);
	const app = createApp({
		store,
		scheduler: new Scheduler(adapters, { store, http, key: () => undefined, now }),
		adapters,
		keys,
		keySpecs: [],
		panels: new PanelCache([], store, now),
		http,
		version: "test",
		sessionToken: "cd".repeat(32),
		now,
	});
	const get = (path: string) =>
		app.fetch(
			new Request(`http://localhost:7722${path}`, { headers: { host: "localhost:7722" } }),
			"127.0.0.1",
		);
	for (const id of ["dahiti-guri", "gaceta-oficial"])
		for (const path of [
			`/api/feeds/${id}/latest`,
			`/api/feeds/${id}/series/${encodeURIComponent(GURI_SERIES)}`,
			`/api/v1/sources/${id}/series`,
			`/api/v1/sources/${id}/series/${encodeURIComponent(GURI_SERIES)}`,
			`/api/v1/sources/${id}/series/${encodeURIComponent(GURI_SERIES)}?format=csv`,
		]) {
			const res = await get(path);
			expect([path, res.status]).toEqual([path, 403]);
			expect(await res.text()).not.toContain("270.1");
		}
});
