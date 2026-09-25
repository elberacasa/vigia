/**
 * Read-API latency against a running Vigía: `bun scripts/perf-api.ts [base-url] [requests-per-route]`.
 * Sequential requests (gzip accepted, body read to the end), paced under the per-client rate limit; prints p50, p95
 * and max per route and the transferred size. ROUTES=/api,/informe limits it to routes starting with those. For the numbers in docs/PERF.md.
 */
const base = (process.argv[2] ?? "http://localhost:7722").replace(/\/+$/, "");
const n = Number(process.argv[3] ?? 40);
const ROUTES = [
	"/api/v1",
	"/api/v1/health",
	"/api/v1/panels/money",
	"/api/v1/panels/money/figures?format=csv",
	"/api/v1/figures?format=csv",
	"/api/v1/sources",
	"/api/v1/incidents",
	"/api/v1/history/connectivity?step=1d",
	"/api/v1/openapi.json",
	"/api",
	"/informe",
];

const pct = (sorted: number[], p: number) =>
	sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
console.log(
	`${"ruta".padEnd(44)} ${"p50 ms".padStart(7)} ${"p95 ms".padStart(7)} ${"máx ms".padStart(7)} ${"gzip".padStart(9)}`,
);
const only = process.env.ROUTES?.split(",");
for (const route of ROUTES.filter((r) => !only || only.some((o) => r.startsWith(o)))) {
	const times: number[] = [];
	let bytes = 0;
	for (let i = 0; i < n + 3; i++) {
		const started = performance.now();
		const res = await fetch(`${base}${route}`, { headers: { "accept-encoding": "gzip" }, decompress: false });
		const body = await res.arrayBuffer();
		const ms = performance.now() - started;
		if (!res.ok) throw new Error(`${route}: HTTP ${res.status}`);
		if (i >= 3) times.push(ms);
		bytes = body.byteLength;
		// Stay under the per-client limit (2 a second, exports cost 5): this measures latency, not the limiter.
		await Bun.sleep(/csv|figures|history/.test(route) ? 2_600 : 520);
	}
	times.sort((a, b) => a - b);
	console.log(
		`${route.padEnd(44)} ${pct(times, 0.5).toFixed(1).padStart(7)} ${pct(times, 0.95).toFixed(1).padStart(7)} ${(times.at(-1) ?? 0).toFixed(1).padStart(7)} ${`${(bytes / 1024).toFixed(1)} KiB`.padStart(9)}`,
	);
}

export {};
