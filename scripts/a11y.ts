/**
 * Automated accessibility check: axe-core (WCAG 2.2 A and AA rules) on Vigía's pages, dark and light, desk and phone
 * widths, against a running Vigía. `bun scripts/a11y.ts [base-url]` (default http://localhost:7722).
 *
 * Exit code 1 when any page has a violation; the full report is written to A11Y_OUT (default: vigia-a11y.json in the temp directory). Too slow for the fast
 * `bun run check` (a real browser, ~1 min), so it runs on demand and in CI (.github/workflows). Automated rules catch
 * roughly a third of accessibility problems; keyboard and screen-reader passes stay manual (docs/OPERATIONS.md).
 *
 * Shared machine: when the heavy-job wrapper exists (A11Y_WRAPPER: a command that runs its arguments), the script
 * re-runs itself under it, so only one heavy job runs at a time.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";

// Shared machine: heavy jobs (a headless browser is one) run one at a time under a wrapper script that holds the
// machine's single lock. When it exists and this run is not already under it, re-run under it.
const wrapper = process.env.A11Y_WRAPPER;
if (wrapper && !process.env.VIGIA_HEAVY_LOCKED && existsSync(wrapper)) {
	const child = Bun.spawn([wrapper, process.execPath, import.meta.path, ...process.argv.slice(2)], {
		stdout: "inherit",
		stderr: "inherit",
	});
	process.exit(await child.exited);
}

const base = (process.argv[2] ?? "http://localhost:7722").replace(/\/+$/, "");
const PAGES = [
	"/",
	"/estado",
	"/guia",
	"/fuentes",
	"/ia",
	"/resumen",
	"/bloqueos",
	"/api",
	"/informe",
] as const;
const THEMES = (process.env.THEMES ?? "dark,light").split(",") as ("dark" | "light")[];
const SIZES = [
	{ name: "desk", width: 1440, height: 900 },
	{ name: "phone", width: 390, height: 844 },
].filter((s) => !process.env.SIZES || process.env.SIZES.split(",").includes(s.name));
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const axeSource = readFileSync(join(import.meta.dir, "..", "node_modules", "axe-core", "axe.min.js"), "utf8");

interface Violation {
	id: string;
	impact: string | null;
	help: string;
	helpUrl: string;
	nodes: { target: string[]; failureSummary?: string }[];
}

const report: { page: string; theme: string; size: string; violations: Violation[] }[] = [];
const started = performance.now();
const browser = await chromium.launch({ args: ["--disable-gpu"] });
try {
	for (const theme of THEMES) {
		for (const size of SIZES) {
			// The app's CSP forbids inline scripts; the checker injects axe inline, so this context bypasses it.
			const context = await browser.newContext({
				viewport: { width: size.width, height: size.height },
				colorScheme: theme,
				reducedMotion: "reduce",
				bypassCSP: true,
				serviceWorkers: "block",
			});
			const page = await context.newPage();
			for (const path of PAGES) {
				await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
				// The app fills its panels from the API; give it time to render real data, not skeletons.
				await page.waitForTimeout(Number(process.env.WAIT ?? 2_500));
				await page.addScriptTag({ content: axeSource });
				const violations = (await page.evaluate(async (tags) => {
					const axe = (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<unknown> } })
						.axe;
					const result = (await axe.run(document, {
						runOnly: { type: "tag", values: tags },
						resultTypes: ["violations"],
					})) as { violations: Violation[] };
					return result.violations.map((v) => ({
						id: v.id,
						impact: v.impact,
						help: v.help,
						helpUrl: v.helpUrl,
						nodes: v.nodes.slice(0, 8).map((n) => ({
							target: n.target,
							...(n.failureSummary ? { failureSummary: n.failureSummary } : {}),
						})),
					}));
				}, TAGS)) as Violation[];
				report.push({ page: path, theme, size: size.name, violations });
				const line = violations.length
					? violations.map((v) => `${v.id} (${v.impact ?? "?"}, ${v.nodes.length})`).join(", ")
					: "sin problemas";
				console.log(
					`${violations.length ? "✗" : "✓"} ${path.padEnd(10)} ${theme.padEnd(5)} ${size.name.padEnd(5)} ${line}`,
				);
			}
			await context.close();
		}
	}
} finally {
	await browser.close();
}

const out = process.env.A11Y_OUT ?? join(tmpdir(), "vigia-a11y.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
const failing = report.filter((r) => r.violations.length > 0);
console.log(
	`\n${report.length} comprobaciones en ${Math.round((performance.now() - started) / 1000)} s; ${failing.length} con problemas. Informe: ${out}`,
);
process.exit(failing.length ? 1 : 0);
