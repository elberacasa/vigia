import type { FeedHealth, FeedState } from "../core/health.ts";

/**
 * Prometheus text exposition (format 0.0.4) for operators: feed health, run durations and errors, request latency.
 * Counters and histograms count from process start; feed gauges are computed at scrape time from the same health
 * the status page shows, so the two can never disagree.
 *
 * Labels are bounded: feed ids come from the adapter registry, route families from a fixed list, status as a class
 * (2xx…5xx). No path, query, address or user agent is ever a label.
 */

export const ROUTE_FAMILIES = [
	"api_v1",
	"api",
	"stream",
	"blobs",
	"history",
	"docs",
	"report",
	"text",
	"metrics",
	"static",
] as const;
export type RouteFamily = (typeof ROUTE_FAMILIES)[number];

/** Which family a path belongs to (a label value, never the path itself). */
export function routeFamily(path: string): RouteFamily {
	if (path === "/metrics") return "metrics";
	if (path === "/api" || path === "/api/") return "docs";
	if (path.startsWith("/api/v1/") || path === "/api/v1") return "api_v1";
	if (path === "/api/stream") return "stream";
	if (path.startsWith("/api/blobs/")) return "blobs";
	if (path.startsWith("/api/history/")) return "history";
	if (path.startsWith("/api/")) return "api";
	if (path === "/informe" || path === "/informe/") return "report";
	if (path === "/ahora.txt") return "text";
	return "static";
}

const REQUEST_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] as const;
const RUN_BUCKETS = [0.25, 0.5, 1, 2, 5, 10, 30, 60, 120] as const;
const STATES: readonly FeedState[] = ["ok", "stale", "degraded", "failing", "locked", "off", "pending"];

class Histogram {
	readonly counts: number[];
	sum = 0;
	count = 0;
	constructor(readonly buckets: readonly number[]) {
		this.counts = buckets.map(() => 0);
	}
	observe(value: number): void {
		this.sum += value;
		this.count++;
		for (let i = 0; i < this.buckets.length; i++)
			if (value <= (this.buckets[i] ?? 0)) this.counts[i] = (this.counts[i] ?? 0) + 1;
	}
}

/** Label value escaping per the exposition format: backslash, double quote, newline. */
export function labelValue(v: string): string {
	return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function labels(pairs: Record<string, string>): string {
	const parts = Object.entries(pairs).map(([k, v]) => `${k}="${labelValue(v)}"`);
	return parts.length ? `{${parts.join(",")}}` : "";
}

function num(v: number): string {
	if (Number.isNaN(v)) return "NaN";
	if (v === Number.POSITIVE_INFINITY) return "+Inf";
	if (v === Number.NEGATIVE_INFINITY) return "-Inf";
	return String(Math.round(v * 1e6) / 1e6);
}

export interface MetricsSnapshot {
	readonly health: readonly FeedHealth[];
	readonly streams: number;
	readonly version: string;
	readonly mode: string;
	readonly now: number;
}

export class Metrics {
	readonly #requests = new Map<string, number>();
	readonly #latency = new Map<RouteFamily, Histogram>();
	readonly #runs = new Map<string, number>();
	readonly #inserted = new Map<string, number>();
	readonly #runDurations = new Map<string, Histogram>();
	readonly startedAt: number;

	constructor(now: number = Date.now()) {
		this.startedAt = now;
	}

	observeRequest(family: RouteFamily, status: number, seconds: number): void {
		const key = `${family}|${Math.floor(status / 100)}xx`;
		this.#requests.set(key, (this.#requests.get(key) ?? 0) + 1);
		let h = this.#latency.get(family);
		if (!h) {
			h = new Histogram(REQUEST_BUCKETS);
			this.#latency.set(family, h);
		}
		h.observe(seconds);
	}

	observeRun(feed: string, ok: boolean, inserted: number, seconds: number | null): void {
		const key = `${feed}|${ok ? "ok" : "error"}`;
		this.#runs.set(key, (this.#runs.get(key) ?? 0) + 1);
		this.#inserted.set(feed, (this.#inserted.get(feed) ?? 0) + inserted);
		if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return;
		let h = this.#runDurations.get(feed);
		if (!h) {
			h = new Histogram(RUN_BUCKETS);
			this.#runDurations.set(feed, h);
		}
		h.observe(seconds);
	}

	render(s: MetricsSnapshot): string {
		const out: string[] = [];
		const head = (name: string, type: string, help: string) => {
			out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
		};
		const hist = (name: string, key: Record<string, string>, h: Histogram) => {
			h.buckets.forEach((b, i) => {
				out.push(`${name}_bucket${labels({ ...key, le: num(b) })} ${h.counts[i] ?? 0}`);
			});
			out.push(`${name}_bucket${labels({ ...key, le: "+Inf" })} ${h.count}`);
			out.push(`${name}_sum${labels(key)} ${num(h.sum)}`, `${name}_count${labels(key)} ${h.count}`);
		};

		head("vigia_build_info", "gauge", "Version and deployment mode of this Vigía.");
		out.push(`vigia_build_info${labels({ version: s.version, mode: s.mode })} 1`);
		head("vigia_start_time_seconds", "gauge", "When this process started (Unix seconds).");
		out.push(`vigia_start_time_seconds ${num(this.startedAt / 1000)}`);

		head(
			"vigia_feed_state",
			"gauge",
			"1 for the feed's current state (the status page's state), 0 otherwise.",
		);
		for (const f of s.health)
			for (const state of STATES)
				out.push(`vigia_feed_state${labels({ feed: f.id, state })} ${f.state === state ? 1 : 0}`);
		head("vigia_feed_fetch_age_seconds", "gauge", "Seconds since the feed's last successful run.");
		for (const f of s.health)
			if (f.fetchAgeMs !== null)
				out.push(`vigia_feed_fetch_age_seconds${labels({ feed: f.id })} ${num(f.fetchAgeMs / 1000)}`);
		head("vigia_feed_data_age_seconds", "gauge", "Seconds since the newest observation's observed time.");
		for (const f of s.health)
			if (f.dataAgeMs !== null)
				out.push(`vigia_feed_data_age_seconds${labels({ feed: f.id })} ${num(f.dataAgeMs / 1000)}`);
		head("vigia_feed_consecutive_failures", "gauge", "Failed runs in a row (circuit breaker).");
		for (const f of s.health)
			out.push(`vigia_feed_consecutive_failures${labels({ feed: f.id })} ${f.consecutiveFailures}`);
		head("vigia_feed_success_ratio", "gauge", "Share of successful runs among the last 50 recorded.");
		for (const f of s.health)
			if (f.successRate !== null)
				out.push(`vigia_feed_success_ratio${labels({ feed: f.id })} ${num(f.successRate)}`);

		head("vigia_feed_runs_total", "counter", "Feed runs since start, by result.");
		for (const [key, n] of [...this.#runs].sort()) {
			const [feed = "", result = ""] = key.split("|");
			out.push(`vigia_feed_runs_total${labels({ feed, result })} ${n}`);
		}
		head("vigia_feed_observations_inserted_total", "counter", "New observations stored since start.");
		for (const [feed, n] of [...this.#inserted].sort())
			out.push(`vigia_feed_observations_inserted_total${labels({ feed })} ${n}`);
		head("vigia_feed_run_duration_seconds", "histogram", "Duration of feed runs since start.");
		for (const [feed, h] of [...this.#runDurations].sort((a, b) => a[0].localeCompare(b[0])))
			hist("vigia_feed_run_duration_seconds", { feed }, h);

		head(
			"vigia_http_requests_total",
			"counter",
			"HTTP responses since start, by route family and status class.",
		);
		for (const [key, n] of [...this.#requests].sort()) {
			const [family = "", code = ""] = key.split("|");
			out.push(`vigia_http_requests_total${labels({ family, code })} ${n}`);
		}
		head("vigia_http_request_duration_seconds", "histogram", "Time to produce a response, by route family.");
		for (const [family, h] of [...this.#latency].sort((a, b) => a[0].localeCompare(b[0])))
			hist("vigia_http_request_duration_seconds", { family }, h);

		head("vigia_stream_clients", "gauge", "Open live-update streams (server-sent events).");
		out.push(`vigia_stream_clients ${s.streams}`);
		return `${out.join("\n")}\n`;
	}
}
