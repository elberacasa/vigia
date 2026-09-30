/**
 * First-load performance on a slow phone profile: `bun scripts/perf.ts [url]`.
 * Chrome DevTools throttling: 400 kbit/s down, 150 kbit/s up, 400 ms RTT (a busy 3G link), CPU 4× slower.
 * Reports first contentful paint, when the priority list appears (data on screen; it replaced the "Ahora" line), transferred bytes, and a repeat
 * visit (service worker cache).
 */
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:7722/";
const browser = await chromium.launch({ args: ["--disable-gpu"] });
try {
	// PERF_VIEW=desk measures the desk's workstation (1440×900, its shell is a chunk of its own) on the same link.
	const desk = process.env.PERF_VIEW === "desk";
	const context = await browser.newContext(
		desk
			? { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }
			: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
	);
	for (const visit of ["first", "repeat"] as const) {
		const page = await context.newPage();
		const cdp = await context.newCDPSession(page);
		await cdp.send("Network.enable");
		await cdp.send("Network.emulateNetworkConditions", {
			offline: false,
			latency: 400,
			downloadThroughput: (400 * 1024) / 8,
			uploadThroughput: (150 * 1024) / 8,
		});
		await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
		let bytes = 0;
		cdp.on("Network.loadingFinished", (e: { encodedDataLength: number }) => {
			bytes += e.encodedDataLength;
		});
		const t0 = Date.now();
		await page.goto(url, { waitUntil: "commit" });
		// PERF_WAIT overrides the "data on screen" marker (".ahora__text" measures a client from before 2026-09-28).
		await page
			.locator(process.env.PERF_WAIT ?? '.prio__list, .prio__empty[data-state="stale"]')
			.first()
			.waitFor({ timeout: 60_000 });
		const dataMs = Date.now() - t0;
		const fcp = await page.evaluate(
			() => performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
		);
		console.log(
			`${visit}: FCP ${fcp === null ? "?" : Math.round(fcp)} ms · data on screen ${dataMs} ms · ${(bytes / 1024).toFixed(1)} KiB transferred`,
		);
		await page.waitForTimeout(1500);
		await page.close();
	}
} finally {
	await browser.close();
}
