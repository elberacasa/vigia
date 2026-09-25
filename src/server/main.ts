import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { purgeStoredGaceta } from "../adapters/gaceta-oficial/purge.ts";
import { ADAPTERS } from "../adapters/registry.ts";
import { OUTLETS } from "../adapters/rss/outlets.ts";
import { AiRuntime } from "../ai/runtime.ts";
import { AlertService } from "../alerts/service.ts";
import { openKeyStore } from "../config/keys.ts";
import { resolvePaths } from "../config/paths.ts";
import { loadSessionToken } from "../config/session.ts";
import { openSettings } from "../config/settings.ts";
import { BlobStore } from "../core/blobs.ts";
import { HttpClient } from "../core/http.ts";
import { Scheduler, type SchedulerEvent } from "../core/scheduler.ts";
import { Store } from "../core/store.ts";
import type { Json } from "../core/types.ts";
import { pruneInBackground, sealInBackground } from "../intel/chain.ts";
import { acquireInstanceLock } from "../ops/instance-lock.ts";
import { createLookup } from "../panels/netwatch-lookup.ts";
import { KEY_SPECS } from "../sources/keys.ts";
import { SafeHttp } from "../userfeeds/net.ts";
import { userNewsPanel } from "../userfeeds/panel.ts";
import { UserFeeds } from "../userfeeds/service.ts";
import { createApp } from "./app.ts";
import { clientAddress, type DeployConfig } from "./config.ts";
import { EMBEDDED } from "./embedded.gen.ts";
import { PANELS } from "./panel-registry.ts";
import { PanelCache } from "./panels.ts";
import { staticServer } from "./static.ts";

export const MIN_RETENTION_DAYS = 35;

export interface ServeOptions {
	readonly port: number;
	readonly host: string;
	readonly version: string;
	readonly quiet?: boolean;
	/** Serve what is stored without fetching any source (design work on a snapshot; ages keep growing honestly). */
	readonly noFetch?: boolean;
	/** Deployment settings validated at start (src/server/config.ts); absent: local mode defaults. */
	readonly deploy?: Pick<DeployConfig, "mode" | "cors" | "metrics" | "trustProxy">;
}

export async function serve(options: ServeOptions) {
	const paths = resolvePaths();
	mkdirSync(paths.data, { recursive: true });
	mkdirSync(paths.config, { recursive: true });
	// One Vigía per data directory: a second one on the same data is refused before it opens anything (review 4 L5).
	const held = acquireInstanceLock(paths.data);
	if (!held.ok)
		throw new Error(
			`ya hay un Vigía abierto con estos datos (proceso ${held.pid ?? "desconocido"}, ${paths.data}). Ciérralo primero, o usa otra carpeta con VIGIA_HOME.`,
		);
	const instanceLock = held.lock;
	const store = new Store(join(paths.data, "vigia.sqlite"));
	// Gaceta titles stored by older versions under the old redaction (code review 4, H1).
	purgeStoredGaceta(store, Date.now());
	const keys = openKeyStore(paths.config);
	const settings = openSettings(paths.config);
	const sessionToken = loadSessionToken(paths.config);
	const http = new HttpClient();
	const blobs = new BlobStore(join(paths.data, "blobs"));
	let publishAi: (labelled: number) => void = () => {};
	const ai = new AiRuntime(
		store,
		http,
		(id) => keys.get(id),
		() => settings.data.ai,
		(labelled) => publishAi(labelled),
	);
	// "Mis fuentes": the user's own feeds, fetched through the SSRF-safe client, shown in their own panel.
	const userFeeds = new UserFeeds(
		{ list: () => settings.data.userFeeds, save: (next) => settings.setUserFeeds(next) },
		new SafeHttp(),
	);
	// A public read-only mirror has no personal features: no user feeds, no user-news panel, no alerts.
	const personal = (options.deploy?.mode ?? "local") !== "public";
	const panels = new PanelCache(
		[...PANELS, ai.panel(), ...(personal ? [userNewsPanel(userFeeds)] : [])],
		store,
	);
	const outletIds = new Set(OUTLETS.map((o) => o.id));

	let publish: ((event: SchedulerEvent) => void) | null = null;
	// "Mis alertas": rules evaluated on the server after new data lands; fired alerts go to open pages over SSE.
	// (`app` is read only by callbacks that run after it exists.)
	const alerts: AlertService = new AlertService({
		file: join(paths.data, "alerts.json"),
		rules: () => settings.data.alertRules,
		saveRules: (next) => settings.setAlertRules(next),
		panel: (id) => panels.get(id),
		health: () => app.health(),
		publish: (alert) => app.notify({ type: "alert", alert: alert as unknown as Json }),
		log: options.quiet ? () => {} : (line) => console.log(`[vigia] ${line}`),
	});
	const scheduler = new Scheduler([...ADAPTERS, ...(personal ? userFeeds.adapters() : [])], {
		store,
		http,
		key: (id) => keys.get(id),
		enabled: (adapter) => settings.feedEnabled(adapter),
		blobs,
		onEvent: (event) => {
			publish?.(event);
			if (event.inserted > 0 && outletIds.has(event.source)) ai.schedule();
			if (event.inserted > 0)
				if (personal)
					alerts.onPanelsChanged(
						panels.panels.filter((p) => p.sources.includes(event.source)).map((p) => p.id),
					);
		},
		log: options.quiet ? () => {} : (line) => console.log(`[feed] ${line}`),
	});

	const app = createApp({
		store,
		scheduler,
		adapters: ADAPTERS,
		keys,
		keySpecs: KEY_SPECS,
		setFeedEnabled: (id, on) => settings.setFeed(id, on),
		writeBrief: () => ai.writeTodaysBrief(),
		lookupDomain: createLookup({ store, http, live: !options.noFetch }),
		setAi: (next) => {
			settings.setAi(next);
			panels.invalidate("ai-news");
			void ai.run();
		},
		panels,
		http,
		blobs,
		version: options.version,
		lan: !["127.0.0.1", "localhost", "::1"].includes(options.host),
		sessionToken,
		...(options.deploy ? { deploy: options.deploy } : {}),
		staticFile: staticServer(join(import.meta.dir, "..", "..", "web", "dist"), EMBEDDED),
		...(personal ? { userFeeds, alerts } : {}),
	});
	if (personal) {
		userFeeds.attach(scheduler);
		alerts.start();
	}
	publish = (event) => app.publish(event);
	publishAi = (labelled) =>
		app.publish({
			type: "run",
			source: "ai-news",
			ok: true,
			inserted: Math.max(1, labelled),
			series: [],
			at: Date.now(),
		});
	if (settings.data.ai.news !== "off") void ai.run();

	let server: ReturnType<typeof Bun.serve>;
	try {
		server = Bun.serve({
			port: options.port,
			hostname: options.host,
			idleTimeout: 60,
			// Never share the port with another process (a second Vigía with other data would answer half the requests).
			reusePort: false,
			// Never Bun's development error page: it prints stack traces with this machine's paths.
			development: false,
			fetch(request, srv) {
				const peer = srv.requestIP(request)?.address ?? "unknown";
				const ip = clientAddress(
					peer,
					request.headers.get("x-forwarded-for"),
					options.deploy?.trustProxy ?? [],
				);
				// Only the live stream may stay open indefinitely; every other connection times out.
				if (streamPath(request.url)) srv.timeout(request, 0);
				return app.fetch(request, ip);
			},
			error(error) {
				console.error("[server]", error instanceof Error ? error.message : error);
				return new Response('{"error":"Error interno."}', {
					status: 500,
					headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
				});
			},
		});
	} catch (error) {
		// The port was taken: let go of the data directory, so the next attempt is not refused for the wrong reason.
		store.close();
		instanceLock.release();
		throw error;
	}
	if (!options.noFetch) scheduler.start();
	// Archive the settled hours of the connectivity history (sliced, yields to requests); then new IODA bins keep it
	// current (App.publish).
	const warmTimer = setTimeout(() => void app.warmHistory(), 15_000);
	warmTimer.unref?.();
	// Computing incidents archives them: do it every 5 min so they are recorded even with nobody looking.
	const incidentsTimer = setInterval(() => panels.get("incidents"), 5 * 60_000);
	incidentsTimer.unref?.();
	// The archive's hash chain: seal each closed UTC day (an hour after midnight UTC); checked hourly. Off the request
	// path: hashing is done a slice at a time (a large archive's first seal is seconds of work; docs/PERF.md).
	const closing = new AbortController();
	const seal = () =>
		sealInBackground(store, Date.now(), { signal: closing.signal }).catch((error: unknown) => {
			if (!closing.signal.aborted)
				console.error("[vigia] sellado:", error instanceof Error ? error.message : error);
		});
	void seal();
	const sealTimer = setInterval(() => void seal(), 3_600_000);
	sealTimer.unref?.();

	// Housekeeping, daily: run logs older than 30 days; observations only when the user set a retention. Pruning
	// waits for any sealing in progress and records each deleted sealed row's hash, so the chain still verifies.
	const housekeeping = async () => {
		try {
			const now = Date.now();
			store.pruneRuns(now - 30 * 86_400_000);
			// Never below 35 days: the panels read 30-day windows (quakes, blocks, night lights).
			const days = settings.data.retentionDays;
			if (days > 0)
				await pruneInBackground(store, now - Math.max(MIN_RETENTION_DAYS, days) * 86_400_000, now, {
					signal: closing.signal,
				});
		} catch (error) {
			if (!closing.signal.aborted)
				console.error("[vigia] limpieza:", error instanceof Error ? error.message : error);
		}
	};
	void housekeeping();
	const housekeepingTimer = setInterval(() => void housekeeping(), 86_400_000);
	housekeepingTimer.unref?.();

	/**
	 * Graceful stop (SIGINT/SIGTERM): no new work, open streams closed, in-flight requests finished, feed runs in
	 * progress given a moment to record themselves, then the database closed (its WAL checkpointed). Bounded, so a
	 * stuck request can never keep a container from stopping.
	 */
	const stop = async (graceMs = 8_000): Promise<void> => {
		const deadline = Date.now() + graceMs;
		closing.abort();
		clearTimeout(warmTimer);
		clearInterval(housekeepingTimer);
		clearInterval(incidentsTimer);
		clearInterval(sealTimer);
		alerts.stop();
		scheduler.stop();
		app.closeStreams();
		await Promise.race([
			server.stop(false),
			new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now()))),
		]);
		// Every run in flight, the user's own feeds included (review 4 L6).
		await scheduler.drain(deadline);
		void server.stop(true);
		try {
			// Fold the WAL into the database file, so a stopped Vigía leaves one self-contained file behind.
			store.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
		} catch (error) {
			console.error("[vigia] cierre:", error instanceof Error ? error.message : error);
		}
		store.close();
		instanceLock.release();
	};
	return { server, store, scheduler, app, paths, sessionToken, stop };
}

/** Whether a request targets the live stream; a URL that does not parse is simply not the stream. */
export function streamPath(raw: string): boolean {
	try {
		return new URL(raw).pathname === "/api/stream";
	} catch {
		return false;
	}
}
