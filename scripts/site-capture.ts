/**
 * Captures the landing page's product media (site/). Read-only: it loads pages and GETs public endpoints of a
 * RUNNING Vigía in a fresh browser profile, so the instance's settings are never touched.
 *
 *   bun scripts/site-capture.ts [vigia-url] [site-url]   defaults http://localhost:7722, http://localhost:7761
 *   ONLY=stills,crops,video,gif,og,mapstill               run some steps only
 *
 * From Vigía (site/public/media/): hero.webm and hero.mp4 (a silent recording: the wall, a state, the Ctrl+K search,
 * the history replay, the phone), poster.webp, still-desk.webp, still-phone.webp, crops/<panel>.webp (dark) and
 * crops/<panel>-light.webp; and site/src/data/media.json (recording time and chapters). docs/assets/demo.gif (800 px
 * wide) for the README.
 * From the built site (mapstill): map-still-<theme>-<640|960|1280>.webp, the hero map's first paint.
 * og: site/public/og.png (1200×630), rendered from site/scripts/og.html with the numbers in facts.json.
 * Last, every file under site/public/media gets a content-hashed name (scripts/site/media.ts) and
 * site/src/data/media-files.json maps the plain names to them, so a new capture is never hidden by a year-long cache.
 *
 * Needs ffmpeg (libvpx-vp9, libx264) and ImageMagick. Heavy (a headless browser and video encodes): on a shared or
 * hot machine, run it at low priority on a few cores.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { hashMedia } from "./site/media.ts";

const ROOT = join(import.meta.dir, "..");
const URL_BASE = (process.argv[2] ?? "http://localhost:7722").replace(/\/$/, "");
const SITE = (process.argv[3] ?? "http://localhost:7761").replace(/\/$/, "");
const TMP = join(ROOT, "runs", "tmp", "site-capture");
const ASSETS = join(ROOT, "site", "public", "media");
const DATA = join(ROOT, "site", "src", "data");
const only = process.env.ONLY?.split(",");
const want = (step: string) => !only || only.includes(step);

for (const d of [TMP, ASSETS, join(ASSETS, "crops"), DATA, join(ROOT, "docs", "assets")])
	mkdirSync(d, { recursive: true });

async function run(cmd: string[]): Promise<void> {
	const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
	const code = await p.exited;
	if (code !== 0)
		throw new Error(`${cmd[0]} failed (${code}): ${(await new Response(p.stderr).text()).slice(-800)}`);
}
const kib = (path: string) => `${(statSync(path).size / 1024).toFixed(0)} KiB`;

/** A still as a high-quality WebP (the site's image optimiser serves AVIF/WebP at the sizes each screen needs). */
async function still(png: string, out: string, width: number, quality = 88): Promise<void> {
	const file = join(ASSETS, `${out}.webp`);
	await run([
		"magick",
		png,
		"-filter",
		"Lanczos",
		"-resize",
		`${width}x`,
		"-quality",
		String(quality),
		"-define",
		"webp:method=6",
		file,
	]);
	console.log(`${out}.webp ${kib(file)}`);
}

// ---------- Browser helpers ----------

/** A visible pointer and key hints for the recording (headless Chromium draws no cursor). Demonstration only. */
const POINTER = `
addEventListener("DOMContentLoaded", () => {
	const s = document.createElement("style");
	s.textContent = \`
	#cap-cursor{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;
		transform:translate(-100px,-100px);filter:drop-shadow(0 1px 2px rgb(0 0 0/.6))}
	#cap-ring{position:fixed;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;z-index:2147483646;
		pointer-events:none;border:2px solid #f6b532;opacity:0;transform:translate(-100px,-100px)}
	#cap-ring.on{animation:cap-ring .5s ease-out}
	@keyframes cap-ring{0%{opacity:.9;scale:.4}100%{opacity:0;scale:1.3}}
	#cap-keys{position:fixed;left:50%;bottom:64px;translate:-50% 0;z-index:2147483647;pointer-events:none;display:flex;gap:6px;
		opacity:0;transition:opacity .2s}
	#cap-keys.on{opacity:1}
	#cap-keys kbd{font:600 20px/1 "Chivo Mono",monospace;color:#edeff3;background:#161b25;border:1px solid #333c4d;
		border-bottom-width:3px;border-radius:8px;padding:10px 14px}\`;
	document.head.append(s);
	const c = document.createElement("div");
	c.id = "cap-cursor";
	c.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2l15 9-6.5 1.4L8.4 19z" fill="#edeff3" stroke="#07090e" stroke-width="1.4" stroke-linejoin="round"/></svg>';
	const r = document.createElement("div");
	r.id = "cap-ring";
	const k = document.createElement("div");
	k.id = "cap-keys";
	document.body.append(c, r, k);
	addEventListener("mousemove", (e) => { c.style.transform = \`translate(\${e.clientX - 3}px,\${e.clientY - 2}px)\`; }, true);
	addEventListener("mousedown", (e) => {
		r.style.transform = \`translate(\${e.clientX}px,\${e.clientY}px)\`;
		r.classList.remove("on"); void r.offsetWidth; r.classList.add("on");
	}, true);
	window.__capKeys = (keys) => {
		k.innerHTML = keys.map((x) => "<kbd>" + x + "</kbd>").join("");
		k.classList.add("on");
		setTimeout(() => k.classList.remove("on"), 1400);
	};
});`;

interface Frame {
	file: string;
	t: number;
}

/** Records the page with the DevTools screencast (sharp JPEG frames, timestamped) while `act` runs. */
async function record(page: Page, name: string, act: () => Promise<void>): Promise<string> {
	const dir = join(TMP, `frames-${name}`);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const cdp = await page.context().newCDPSession(page);
	const frames: Frame[] = [];
	let n = 0;
	cdp.on("Page.screencastFrame", (f) => {
		const file = join(dir, `${String(n++).padStart(5, "0")}.jpg`);
		writeFileSync(file, Buffer.from(f.data, "base64"));
		frames.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 });
		void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
	});
	await cdp.send("Page.startScreencast", { format: "jpeg", quality: 94, everyNthFrame: 1 });
	const start = Date.now() / 1000;
	await act();
	const end = Date.now() / 1000;
	await cdp.send("Page.stopScreencast");
	await cdp.detach();
	if (frames.length === 0) throw new Error(`${name}: no frames`);
	// Constant-rate intermediate: each frame lasts until the next one (the screencast only sends changes).
	const lines = ["ffconcat version 1.0"];
	const first = frames[0];
	if (first) {
		lines.push(`file '${first.file}'`, `duration ${Math.max(0.001, first.t - start).toFixed(4)}`);
	}
	frames.forEach((f, i) => {
		const next = frames[i + 1]?.t ?? end;
		lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
	});
	const last = frames.at(-1);
	if (last) lines.push(`file '${last.file}'`);
	const list = join(dir, "list.txt");
	writeFileSync(list, `${lines.join("\n")}\n`);
	const out = join(TMP, `${name}.mkv`);
	await run([
		"ffmpeg",
		"-y",
		"-loglevel",
		"error",
		"-f",
		"concat",
		"-safe",
		"0",
		"-i",
		list,
		"-vf",
		"fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv444p",
		"-c:v",
		"libx264",
		"-crf",
		"8",
		"-preset",
		"veryfast",
		out,
	]);
	console.log(`${name}: ${frames.length} frames, ${(end - start).toFixed(1)} s`);
	return out;
}

async function glide(page: Page, x: number, y: number, ms = 700): Promise<void> {
	const steps = Math.max(8, Math.round(ms / 16));
	await page.mouse.move(x, y, { steps });
}

async function centreOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
	const box = await page.locator(selector).first().boundingBox();
	if (!box) throw new Error(`not visible: ${selector}`);
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function openDesk(
	browser: Browser,
	scale = 1,
	colorScheme: "dark" | "light" = "dark",
): Promise<{ ctx: BrowserContext; page: Page }> {
	const ctx = await browser.newContext({
		viewport: { width: 1440, height: 900 },
		deviceScaleFactor: scale,
		colorScheme,
		reducedMotion: "no-preference",
	});
	const page = await ctx.newPage();
	await page.goto(`${URL_BASE}/`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(4500);
	return { ctx, page };
}

async function openPhone(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
	const ctx = await browser.newContext({
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 2,
		isMobile: true,
		hasTouch: true,
		colorScheme: "dark",
	});
	const page = await ctx.newPage();
	await page.goto(`${URL_BASE}/`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(4500);
	return { ctx, page };
}

const needsBrowser = ["stills", "crops", "video", "og", "mapstill"].some(want);
const browser = needsBrowser
	? await chromium.launch({ args: ["--disable-gpu", "--use-angle=swiftshader"] })
	: null;

try {
	// ---------- Stills: desktop and phone, at 2x; the video's poster ----------
	if (browser && want("stills")) {
		const { ctx, page } = await openDesk(browser, 2);
		await page.screenshot({ path: join(TMP, "still-desk.png") });
		await ctx.close();
		await still(join(TMP, "still-desk.png"), "still-desk", 2880);
		await still(join(TMP, "still-desk.png"), "poster", 1280, 80);
		const phone = await openPhone(browser);
		await phone.page.screenshot({ path: join(TMP, "still-phone.png") });
		await phone.ctx.close();
		await still(join(TMP, "still-phone.png"), "still-phone", 780);
	}

	// ---------- Panel crops: the top of each panel, 2x, in both themes ----------
	if (browser && want("crops")) {
		const ids = [
			"dinero",
			"conectividad",
			"censura",
			"sismos",
			"clima",
			"incendios",
			"luces",
			"energia",
			"mercados",
			"humanitario",
			"servicios",
			"gaceta",
			"tv",
			"bolsillo",
			"noticias",
			"incidentes",
		];
		for (const theme of ["dark", "light"] as const) {
			const { ctx, page } = await openDesk(browser, 2, theme);
			for (const id of ids) {
				const el = page.locator(`section#${id}`);
				// Top of the panel just under the app's sticky top bar.
				await el.evaluate((e) => {
					e.scrollIntoView({ block: "start" });
					scrollBy(0, -72);
				});
				await page.waitForTimeout(1600);
				const box = await el.boundingBox();
				if (!box) throw new Error(`panel ${id} not found`);
				const file = join(TMP, `crop-${id}-${theme}.png`);
				await page.screenshot({
					path: file,
					clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, box.width * 0.62) },
				});
				await still(file, `crops/${id}${theme === "light" ? "-light" : ""}`, 720, 86);
			}
			await ctx.close();
		}
	}

	// ---------- The recording ----------
	if (browser && want("video")) {
		const chapters: { at: number; es: string; en: string }[] = [];
		const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
		await desk.addInitScript(POINTER);
		const page = await desk.newPage();
		await page.goto(`${URL_BASE}/`, { waitUntil: "domcontentloaded" });
		await page.waitForTimeout(4500);
		await page.mouse.move(1180, 640);
		const recordedAt = Date.now();
		let t0 = 0;
		const chapter = (es: string, en: string) => chapters.push({ at: Date.now() / 1000 - t0, es, en });
		const deskClip = await record(page, "desk", async () => {
			t0 = Date.now() / 1000;
			chapter("El muro", "The wall");
			await page.waitForTimeout(2400);
			// A state on the map: the map zooms in and the state's sheet opens.
			const sucre = await centreOf(page, '.panel--map [aria-label^="Sucre"]');
			chapter("Un estado", "A state");
			await glide(page, sucre.x, sucre.y, 900);
			await page.waitForTimeout(350);
			await page.mouse.click(sucre.x, sucre.y);
			await page.waitForTimeout(3400);
			await page.keyboard.press("Escape");
			await page.waitForTimeout(900);
			// The palette: a municipality by name.
			chapter("Búsqueda Ctrl K", "Ctrl K search");
			await page.evaluate(() =>
				(window as unknown as { __capKeys: (k: string[]) => void }).__capKeys(["Ctrl", "K"]),
			);
			await page.waitForTimeout(250);
			await page.keyboard.press("Control+k");
			await page.waitForTimeout(500);
			await page.keyboard.type("maracaibo", { delay: 110 });
			await page.waitForTimeout(900);
			await page.keyboard.press("Enter");
			await page.waitForTimeout(3600);
			await page.keyboard.press("Escape");
			await page.waitForTimeout(700);
			// The history strip: 7 days, replayed from stored observations.
			chapter("Historial", "History");
			const week = await centreOf(page, ".range-chip >> nth=1");
			await glide(page, week.x, week.y, 800);
			await page.mouse.click(week.x, week.y);
			await page.waitForTimeout(1200);
			const play = await centreOf(page, ".timeline-strip__play");
			await glide(page, play.x, play.y, 500);
			await page.mouse.click(play.x, play.y);
			await page.waitForTimeout(6800);
		});
		await desk.close();

		const { ctx, page: phone } = await openPhone(browser);
		const phoneClip = await record(phone, "phone", async () => {
			await phone.waitForTimeout(1500);
			for (let i = 0; i < 60; i++) {
				await phone.evaluate(() => scrollBy(0, 14));
				await phone.waitForTimeout(33);
			}
			await phone.waitForTimeout(1200);
			await phone.locator(".tabbar__tab", { hasText: "Dólar" }).first().tap();
			await phone.waitForTimeout(2800);
			await phone.locator(".tabbar__tab", { hasText: "Mapa" }).first().tap();
			await phone.waitForTimeout(2800);
		});
		await ctx.close();

		const probe = async (f: string) => {
			const p = Bun.spawn(
				["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f],
				{
					stdout: "pipe",
				},
			);
			return Number((await new Response(p.stdout).text()).trim());
		};
		// The phone clip centred on the brand background in a rounded frame, then everything joined with a fade.
		const dPhone = await probe(phoneClip);
		const mask = join(TMP, "phone-mask.png");
		await run([
			"magick",
			"-size",
			"390x844",
			"xc:black",
			"-fill",
			"white",
			"-draw",
			"roundrectangle 0,0 389,843 30,30",
			mask,
		]);
		const phoneStage = join(TMP, "phone-stage.mkv");
		await run([
			"ffmpeg",
			"-y",
			"-loglevel",
			"error",
			"-i",
			phoneClip,
			"-loop",
			"1",
			"-t",
			dPhone.toFixed(3),
			"-i",
			mask,
			"-filter_complex",
			[
				"[0:v]scale=390:844:flags=lanczos,format=yuva444p[p]",
				"[1:v]format=gray,scale=390:844[m]",
				"[p][m]alphamerge[pm]",
				`color=c=0x07090e:s=1440x900:r=30:d=${dPhone.toFixed(3)}[bg]`,
				"[bg]drawbox=x=523:y=27:w=394:h=846:color=0x333c4d:t=fill[bgb]",
				"[bgb][pm]overlay=x=525:y=28:shortest=1,format=yuv444p",
			].join(";"),
			"-t",
			dPhone.toFixed(3),
			"-c:v",
			"libx264",
			"-crf",
			"8",
			"-preset",
			"veryfast",
			phoneStage,
		]);
		const dDesk = await probe(deskClip);
		const joined = join(TMP, "joined.mkv");
		const fade = 0.5;
		chapters.push({ at: dDesk - fade, es: "En el teléfono", en: "On a phone" });
		await run([
			"ffmpeg",
			"-y",
			"-loglevel",
			"error",
			"-i",
			deskClip,
			"-i",
			phoneStage,
			"-filter_complex",
			`[0:v][1:v]xfade=transition=fade:duration=${fade}:offset=${(dDesk - fade).toFixed(3)},format=yuv420p`,
			"-c:v",
			"libx264",
			"-crf",
			"10",
			"-preset",
			"veryfast",
			joined,
		]);
		const total = await probe(joined);
		// Loops cleanly: fades in from and out to the page's background.
		const ends = `fade=t=in:st=0:d=0.35:color=0x07090e,fade=t=out:st=${(total - 0.35).toFixed(3)}:d=0.35:color=0x07090e`;
		await run([
			"ffmpeg",
			"-y",
			"-loglevel",
			"error",
			"-i",
			joined,
			"-vf",
			`fps=24,scale=1280:-2:flags=lanczos,${ends}`,
			"-an",
			"-c:v",
			"libvpx-vp9",
			"-crf",
			"46",
			"-b:v",
			"0",
			"-row-mt",
			"1",
			"-deadline",
			"good",
			"-cpu-used",
			"2",
			"-g",
			"240",
			"-pix_fmt",
			"yuv420p",
			join(ASSETS, "hero.webm"),
		]);
		await run([
			"ffmpeg",
			"-y",
			"-loglevel",
			"error",
			"-i",
			joined,
			"-vf",
			`fps=24,scale=1280:-2:flags=lanczos,${ends}`,
			"-an",
			"-c:v",
			"libx264",
			"-crf",
			"33",
			"-preset",
			"slow",
			"-tune",
			"stillimage",
			"-profile:v",
			"high",
			"-g",
			"240",
			"-pix_fmt",
			"yuv420p",
			"-movflags",
			"+faststart",
			join(ASSETS, "hero.mp4"),
		]);
		writeFileSync(
			join(DATA, "media.json"),
			`${JSON.stringify({ recordedAt, duration: Math.round(total * 10) / 10, chapters: chapters.map((c) => ({ ...c, at: Math.max(0, Math.round(c.at * 10) / 10) })) }, null, "\t")}\n`,
		);
		console.log(
			`hero.webm ${kib(join(ASSETS, "hero.webm"))}, hero.mp4 ${kib(join(ASSETS, "hero.mp4"))}, ${total.toFixed(1)} s`,
		);
	}

	// ---------- Open Graph image, from site/scripts/og.html and the numbers in facts.json ----------
	if (browser && want("og")) {
		const facts = JSON.parse(await Bun.file(join(DATA, "facts.json")).text()) as {
			sources: number;
			newsPublishers: number;
			keyless: number;
		};
		const n = (v: number) => new Intl.NumberFormat("es-VE").format(v);
		// The desktop still: a fresh capture under its plain name, else its content-hashed file.
		const plainStill = join(ASSETS, "still-desk.webp");
		const stillDesk = existsSync(plainStill)
			? plainStill
			: join(
					ROOT,
					"site",
					"public",
					(JSON.parse(readFileSync(join(DATA, "media-files.json"), "utf8")) as Record<string, string>)[
						"still-desk.webp"
					] ?? "",
				);
		const html = (await Bun.file(join(ROOT, "site", "scripts", "og.html")).text())
			.replaceAll("{{stillDesk}}", `file://${stillDesk}`)
			.replaceAll("{{sources}}", n(facts.sources))
			.replaceAll("{{publishers}}", n(facts.newsPublishers))
			.replaceAll("{{keyless}}", n(facts.keyless));
		const filled = join(ROOT, "site", "scripts", ".og.filled.html");
		writeFileSync(filled, html);
		const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
		const page = await ctx.newPage();
		await page.goto(`file://${filled}`);
		await page.waitForTimeout(900);
		await page.screenshot({ path: join(TMP, "og.png") });
		await ctx.close();
		rmSync(filled);
		await run([
			"magick",
			join(TMP, "og.png"),
			"-strip",
			"-define",
			"png:compression-level=9",
			join(ROOT, "site", "public", "og.png"),
		]);
		console.log(`og.png ${kib(join(ROOT, "site", "public", "og.png"))}`);
	}

	// ---------- The hero map's still, from the built site, in both themes ----------
	if (browser && want("mapstill")) {
		for (const theme of ["dark", "light"] as const) {
			const ctx = await browser.newContext({
				viewport: { width: 1440, height: 900 },
				deviceScaleFactor: 2,
				colorScheme: theme,
			});
			const page = await ctx.newPage();
			await page.goto(`${SITE}/`, { waitUntil: "load" });
			await page.waitForFunction(() => document.querySelector("figure canvas") !== null, null, {
				timeout: 30_000,
			});
			// Only the scene: the page's own backdrop (arc, grid) and the caption are not part of the still.
			await page.addStyleTag({
				content: ".hero-glow,.hero-grid,figure figcaption{visibility:hidden!important}",
			});
			await page.waitForTimeout(4200);
			const host = page.locator("figure canvas").first();
			const file = join(TMP, `map-${theme}.png`);
			await host.screenshot({ path: file, omitBackground: true });
			await ctx.close();
			for (const width of [640, 960, 1280]) {
				await run([
					"magick",
					file,
					"-background",
					theme === "dark" ? "#07090e" : "#f4f1ea",
					"-flatten",
					"-filter",
					"Lanczos",
					"-resize",
					`${width}x`,
					"-quality",
					"82",
					"-define",
					"webp:method=6",
					join(ASSETS, `map-still-${theme}-${width}.webp`),
				]);
			}
			console.log(`map-still-${theme}-1280.webp ${kib(join(ASSETS, `map-still-${theme}-1280.webp`))}`);
		}
	}
} finally {
	await browser?.close();
}

// ---------- The README GIF, from the recording ----------
if (want("gif")) {
	const joined = join(TMP, "joined.mkv");
	const palette = join(TMP, "palette.png");
	const gif = join(ROOT, "docs", "assets", "demo.gif");
	const filters = "fps=10,scale=800:-1:flags=lanczos";
	await run([
		"ffmpeg",
		"-y",
		"-loglevel",
		"error",
		"-i",
		joined,
		"-vf",
		`${filters},palettegen=max_colors=128:stats_mode=diff`,
		palette,
	]);
	await run([
		"ffmpeg",
		"-y",
		"-loglevel",
		"error",
		"-i",
		joined,
		"-i",
		palette,
		"-lavfi",
		`${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
		gif,
	]);
	console.log(`demo.gif ${kib(gif)}`);
}

// ---------- Content-hashed names for everything under site/public/media ----------
const manifest = hashMedia(ASSETS);
writeFileSync(join(DATA, "media-files.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
console.log(`media: ${Object.keys(manifest).length} files, content-hashed (src/data/media-files.json)`);
