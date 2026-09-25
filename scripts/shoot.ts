/**
 * Screenshots of a running Vigía for design review: `bun scripts/shoot.ts [url] [outdir]`.
 * One headless browser at a time (shared machine). Prints console errors.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const only = process.env.SIZES?.split(",");
const url = process.argv[2] ?? "http://localhost:7799/";
const out = process.argv[3] ?? join(import.meta.dir, "..", "runs", "tmp", "shots");
mkdirSync(out, { recursive: true });
const sizes = [
	{ name: "desk", width: 1440, height: 900, scale: 1 },
	{ name: "wall", width: 1920, height: 1080, scale: 1 },
	{ name: "phone", width: 390, height: 844, scale: 2 },
];
const theme = process.env.THEME ?? "dark";
const browser = await chromium.launch({ args: ["--disable-gpu"] });
try {
	for (const s of sizes.filter((x) => !only || only.includes(x.name))) {
		const page = await browser.newPage({
			viewport: { width: s.width, height: s.height },
			deviceScaleFactor: s.scale,
			colorScheme: theme === "light" ? "light" : "dark",
		});
		const errors: string[] = [];
		page.on("console", (m) => {
			if (m.type() === "error") errors.push(m.text());
		});
		page.on("pageerror", (e) => errors.push(e.message));
		await page.goto(url, { waitUntil: "domcontentloaded" });
		await page.waitForTimeout(Number(process.env.WAIT ?? 2500));
		// Optional interaction before the shot, e.g. CLICK='[aria-label^="Zulia"]'.
		if (process.env.CLICK) {
			await page.locator(process.env.CLICK).first().click();
			await page.waitForTimeout(600);
		}
		// Optional key presses, e.g. KEYS='/' or KEYS='Control+k', then TYPE='maracaibo' into what has focus.
		for (const key of (process.env.KEYS ?? "").split(",").filter(Boolean)) {
			await page.keyboard.press(key);
			await page.waitForTimeout(Number(process.env.KEYWAIT ?? 300));
		}
		if (process.env.TYPE) {
			await page.keyboard.type(process.env.TYPE, { delay: 40 });
			await page.waitForTimeout(400);
		}
		const file = join(out, `${s.name}${theme === "light" ? "-light" : ""}.png`);
		// Optional region, CLIP='x,y,width,height' in CSS px (a y below 0 counts from the bottom of the viewport).
		const clip = process.env.CLIP?.split(",").map(Number);
		await page.screenshot({
			path: file,
			fullPage: process.env.FULL === "1",
			...(clip && clip.length === 4
				? {
						clip: {
							x: clip[0] ?? 0,
							y: (clip[1] ?? 0) < 0 ? s.height + (clip[1] ?? 0) : (clip[1] ?? 0),
							width: clip[2] ?? s.width,
							height: clip[3] ?? s.height,
						},
					}
				: {}),
		});
		console.log(
			`${file}  errors=${errors.length}${errors.length ? ` ${errors.slice(0, 3).join(" | ")}` : ""}`,
		);
		await page.close();
	}
} finally {
	await browser.close();
}
