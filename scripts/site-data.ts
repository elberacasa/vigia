/**
 * Writes the data the landing page (site/) is built from, so the site needs nothing outside its own folder:
 *
 *   site/src/data/facts.json      numbers derived from the code (sources, publishers, panels, tests, first load),
 *                                 the release's downloads (docs/releases/v<version>.md) and the captured figure's
 *                                 licence
 *   site/src/data/contracts.json  the Adapter and Observation interfaces as written in src/core/types.ts
 *   site/src/data/map.json        state outlines (the app's own map geometry) and, from a running Vigía, the live
 *                                 layers the hero map draws: connectivity by state, earthquakes, strongest fires
 *   site/src/data/sources.json    every source with its atlas entry, grouped, and regional outlets per state
 *   site/src/data/changelog.json  CHANGELOG.md and each version's release notes (the /cambios page and its feed)
 *   site/src/data/captures/       the terminal report (GET /ahora.txt) and one API row, as the app printed them
 *
 *   bun scripts/site-data.ts [--live http://localhost:7722] [--no-live] [--no-web]
 *
 * --no-live keeps the previous live snapshot (the map layers and captures); --no-web keeps the previous first-load
 * size instead of rebuilding the client. The live part only GETs public, read-only endpoints.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { ADAPTERS } from "../src/adapters/registry.ts";
import { FRAME, NEIGHBOURS, STATES } from "../web/src/map/geometry.gen.ts";
import { changelog } from "./site/changelog.ts";
import { contract, facts, licenceOf, releaseFiles } from "./site/facts.ts";
import { type LiveMap, liveMap, rings } from "./site/map.ts";
import { sources } from "./site/sources.ts";

const ROOT = join(import.meta.dir, "..");
const DATA = join(ROOT, "site", "src", "data");
const CAPTURES = join(DATA, "captures");
mkdirSync(CAPTURES, { recursive: true });

const args = process.argv.slice(2);
const liveAt = args.indexOf("--live");
const liveUrl = ((liveAt >= 0 ? args[liveAt + 1] : undefined) ?? "http://localhost:7722").replace(/\/$/, "");
const live = !args.includes("--no-live");
const web = !args.includes("--no-web");

const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value)}\n`);
const previous = <T>(path: string): T | null =>
	existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;

// ---------- Numbers from the code ----------
async function firstLoadKiB(): Promise<number> {
	const p = Bun.spawn(["bun", "scripts/build-web.ts"], {
		cwd: ROOT,
		env: { ...process.env, QUIET: "1" },
		stdout: "pipe",
		stderr: "inherit",
	});
	const out = await new Response(p.stdout).text();
	if ((await p.exited) !== 0) throw new Error("build-web failed");
	const kib = /first load ([\d.]+)/.exec(out)?.[1];
	if (!kib) throw new Error(`build-web: no first-load size in its output:\n${out}`);
	return Number(kib);
}

const factsPath = join(DATA, "facts.json");
const old = previous<{ firstLoadKiB: number }>(factsPath);
// Tests are counted on what the public repository ships. The export policy is internal tooling that the public
// repository does not have; there, every file already ships.
const policyPath = join(ROOT, "scripts", "export", "policy.ts");
const shipped = existsSync(policyPath)
	? ((await import(policyPath)) as { isPublic: (path: string) => boolean }).isPublic
	: () => true;
const f = facts(ROOT, shipped);
const release = releaseFiles(
	readFileSync(join(ROOT, "docs", "releases", `v${pkg.version}.md`), "utf8"),
	pkg.version,
);
const kib = web ? await firstLoadKiB() : (old?.firstLoadKiB ?? null);
if (kib === null) throw new Error("no previous first-load size: run without --no-web once");
writeJson(join(DATA, "contracts.json"), {
	adapter: contract(ROOT, "Adapter"),
	observation: contract(ROOT, "Observation"),
});
const src = sources(ADAPTERS, f.newsPublishers);
writeJson(join(DATA, "sources.json"), src);
const versions = changelog(ROOT);
writeJson(join(DATA, "changelog.json"), versions);
console.log(
	`sources: ${src.rows.length} in ${src.groups.length} groups, ${src.states.filter((s) => s.outlets > 0).length} states with regional outlets; changelog: ${versions.map((v) => v.version).join(", ")}`,
);
console.log(
	`facts: ${f.sources} sources (${f.keyless} keyless), ${f.newsPublishers} news publishers, ${f.panels} panels, ${f.tests} tests in ${f.testFiles} public files, first load ${kib} KiB gzip; release ${release.map((r) => `${r.target} ${r.mb} MB`).join(", ")}`,
);

// ---------- The map: geometry always, live layers from a running Vigía ----------
const mapPath = join(DATA, "map.json");
let layers: LiveMap | null = previous<{ live: LiveMap }>(mapPath)?.live ?? null;
if (live) {
	layers = await liveMap(liveUrl);
	const ua = { "user-agent": "curl/8.9.1" };
	for (const lang of ["es", "en"] as const) {
		const res = await fetch(`${liveUrl}/ahora.txt${lang === "en" ? "?lang=en" : ""}`, { headers: ua });
		if (!res.ok) throw new Error(`/ahora.txt: HTTP ${res.status}`);
		writeFileSync(join(CAPTURES, `terminal-${lang}.txt`), await res.text());
	}
	const money = (await (await fetch(`${liveUrl}/api/v1/panels/money/figures`)).json()) as {
		figures: unknown[];
	};
	writeFileSync(join(CAPTURES, "api-figure.json"), `${JSON.stringify(money.figures[0], null, 2)}\n`);
	writeJson(join(CAPTURES, "meta.json"), { capturedAt: Date.now() });
	console.log("map: new live layers; recapture the hero still (ONLY=mapstill bun scripts/site-capture.ts)");
	console.log(
		`live: ${layers.connectivity.states.length} states, ${layers.quakes.length} quakes, ${layers.fires.length} fires, as of ${new Date(layers.asOf).toISOString()}`,
	);
}
if (!layers) throw new Error("no live snapshot yet: run once with a Vigía running (--live URL)");
writeJson(mapPath, {
	frame: { width: FRAME.width, height: FRAME.height },
	states: STATES.map((s) => ({ iso: s.iso, name: s.name, label: s.label, rings: rings(s.d) })),
	neighbours: NEIGHBOURS.map((n) => ({ name: n.name, rings: rings(n.d) })),
	live: layers,
});
console.log(`map: ${(readFileSync(mapPath).length / 1024).toFixed(1)} KiB`);

// Last, so the figure's licence matches the capture just taken.
const figure = JSON.parse(readFileSync(join(CAPTURES, "api-figure.json"), "utf8")) as { feed: string };
writeJson(factsPath, {
	...f,
	version: pkg.version,
	release,
	figureLicence: licenceOf(ADAPTERS, figure.feed),
	firstLoadKiB: kib,
	generatedAt: Date.now(),
});
