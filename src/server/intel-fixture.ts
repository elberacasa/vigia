import type { NewsItem } from "../adapters/rss/factory.ts";
import type { KeyStore } from "../config/keys.ts";
import { Scheduler } from "../core/scheduler.ts";
import { Store } from "../core/store.ts";
import type { HttpLike, Observation } from "../core/types.ts";
import { incidentsPanel } from "../panels/incidents.ts";
import { createApp } from "./app.ts";
import { PanelCache } from "./panels.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
export const NOW = Date.UTC(2026, 8, 25, 1, 30);

/** Test fixture: an app over an in-memory store with two outlets reporting a blackout in Zulia. */
function headline(outlet: string, n: number, title: string, at: number): Observation<NewsItem> {
	return {
		source: outlet,
		series: `item:${n}`,
		sourceUrl: `https://example.org/${outlet}/${n}`,
		fetchedAt: at + MIN,
		observedAt: at,
		licence: "headline",
		value: {
			outlet,
			title,
			link: `https://example.org/${outlet}/${n}`,
			summary: "",
			image: null,
			dateMissing: false,
			video: false,
		},
		confidence: 1,
		basis: "report",
	};
}

export function intelSetup(now = NOW) {
	const store = new Store(":memory:");
	store.insert([
		headline(
			"la-verdad",
			1,
			"Habitantes de San Jacinto en Maracaibo cacerolean ante constantes apagones",
			now - 5 * HOUR,
		),
		headline("el-pitazo", 2, "Zulia | Nuevo apagón deja sin luz a Maracaibo y San Francisco", now - HOUR),
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
	const panels = new PanelCache([incidentsPanel], store, () => now);
	const app = createApp({
		store,
		scheduler: new Scheduler([], { store, http, key: () => undefined }),
		adapters: [],
		keys,
		keySpecs: [],
		panels,
		http,
		version: "test",
		sessionToken: "t".repeat(43),
		now: () => now,
	});
	const get = (path: string, ip = "127.0.0.1", headers: Record<string, string> = {}) =>
		app.fetch(
			new Request(`http://localhost:7722${path}`, { headers: { host: "localhost:7722", ...headers } }),
			ip,
		);
	return { store, app, get };
}
