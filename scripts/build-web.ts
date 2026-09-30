/**
 * Builds the web client into web/dist with hashed, minified assets, and prints the transfer sizes that matter
 * on a slow connection (gzip, as served by most proxies; Brotli noted too).
 */
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import type { BunPlugin } from "bun";
import { FIRST_REQUESTS } from "../web/src/lib/first-requests.ts";

const root = join(import.meta.dir, "..");
const outdir = join(root, "web", "dist");
keepPreviousChunks(outdir, join(root, "web", "dist-previous"));
rmSync(outdir, { recursive: true, force: true });

/**
 * A tab opened before this build still asks for the previous build's hashed chunks (review 4, M8: they 404'd and
 * its panels could not load). They move to web/dist-previous, which the server falls back to for hashed files
 * only (src/server/static.ts), and are dropped there after a week.
 */
function keepPreviousChunks(from: string, to: string): void {
	const GRACE_MS = 7 * 86_400_000;
	const hashed = /-[a-z0-9]{8,}\.(js|css|svg|png|webp)$/;
	mkdirSync(to, { recursive: true });
	for (const name of readdirSync(to)) {
		const path = join(to, name);
		if (Date.now() - statSync(path).mtimeMs > GRACE_MS) rmSync(path, { force: true });
	}
	let names: string[] = [];
	try {
		names = readdirSync(from);
	} catch {
		return;
	}
	for (const name of names) {
		if (!hashed.test(name)) continue;
		// The copy's time is the moment it stopped being current: the grace week runs from this build.
		cpSync(join(from, name), join(to, name), { force: true });
	}
}

/**
 * `import css from "./x.css?inline"`: the stylesheet minified into a string, for a chunk that loads on demand to
 * insert when it first runs (lib/css.ts). Bun copies CSS imported from a lazy chunk into the entry stylesheet, so
 * per-feature styles would otherwise all load up front. The sheets are minified first (a build inside a plugin
 * hook deadlocks), then the plugin hands out the strings.
 */
const inlineSheets = new Map<string, string>();
for (const file of new Bun.Glob("web/src/**/*.{ts,tsx}").scanSync(root)) {
	const source = await Bun.file(join(root, file)).text();
	for (const m of source.matchAll(/(?:from |import\()"([^"]+\.css)\?inline"/g)) {
		const path = resolve(root, dirname(file), m[1] as string);
		if (inlineSheets.has(path)) continue;
		const out = await Bun.build({ entrypoints: [path], minify: true, target: "browser" });
		const css = out.success ? await out.outputs[0]?.text() : undefined;
		if (css === undefined) {
			for (const log of out.logs) console.error(log);
			throw new Error(`inline-css: could not build ${path}`);
		}
		inlineSheets.set(path, css.trim());
	}
}
const inlineCss: BunPlugin = {
	name: "inline-css",
	setup(build) {
		build.onResolve({ filter: /\.css\?inline$/ }, (args) => ({
			path: resolve(dirname(args.importer), args.path.replace(/\?inline$/, "")),
			namespace: "inline-css",
		}));
		build.onLoad({ filter: /.*/, namespace: "inline-css" }, (args) => {
			const css = inlineSheets.get(args.path);
			if (css === undefined) throw new Error(`inline-css: ${args.path} was not prepared`);
			return { contents: `export default ${JSON.stringify(css)};`, loader: "js" };
		});
	},
};

/**
 * The crowd report's proof-of-work worker (web/src/crowd/pow.worker.ts) is a file of its own on Vigía's origin: the
 * page's CSP allows scripts from itself only (no blob: workers). Built first, so the page can be given its hashed URL.
 */
const powWorker = await Bun.build({
	entrypoints: [join(root, "web", "src", "crowd", "pow.worker.ts")],
	outdir,
	minify: true,
	target: "browser",
	naming: { entry: "[name]-[hash].[ext]" },
});
const powOut = powWorker.outputs[0];
if (!powWorker.success || !powOut) {
	for (const log of powWorker.logs) console.error(log);
	throw new Error("build-web: the proof-of-work worker did not build");
}
const powUrl = `/${relative(outdir, powOut.path).split("\\").join("/")}`;

const result = await Bun.build({
	entrypoints: [join(root, "web", "index.html")],
	outdir,
	minify: true,
	// Secondary pages load on demand (see web/src/lib/lazy.tsx); the wall is the first load. Code only needed after
	// an action (municipality outlines on a state zoom, share cards) is its own chunk too.
	splitting: true,
	sourcemap: "none",
	target: "browser",
	naming: { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
	define: { "process.env.NODE_ENV": '"production"', __POW_WORKER__: JSON.stringify(powUrl) },
	loader: { ".svg": "file", ".png": "file" },
	external: ["/fonts/*"],
	plugins: [inlineCss],
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
/** `<link rel="modulepreload">` for the workstation chunk, only on screens wide enough to run it. */
function deskPreload(): string {
	// Either separator: on Windows the output paths use "\\" (the 1.0.0 CI build failed on the "/"-only pattern).
	const chunk = result.outputs.find((o) => /[\\/]Workstation-[a-z0-9]+\.js$/.test(o.path));
	if (!chunk) throw new Error("build-web: the Workstation chunk is missing");
	const href = relative(outdir, chunk.path).split(sep).join("/");
	return `<link rel="modulepreload" href="/${href}" media="(min-width: 1000px)">`;
}
// Static files (fonts with a version in the name, icons, manifest) are copied as-is; the page links them after the
// build (Bun's HTML bundler would try to resolve absolute links).
cpSync(join(root, "web", "static"), outdir, { recursive: true });
{
	const indexPath = join(outdir, "index.html");
	const html = await Bun.file(indexPath).text();
	await Bun.write(
		indexPath,
		html
			.replace(
				"</head>",
				'<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icons/icon-180.png"></head>',
			)
			// The app's stylesheet does not block the first paint (the static shell is styled inline): it is preloaded
			// at full priority and main.tsx applies it, waiting for it if needed, before the app replaces the shell.
			.replace(
				/<link rel="stylesheet" crossorigin href="(\.\/index-[a-z0-9]+\.css)">/,
				'<link rel="preload" as="style" crossorigin href="$1" id="app-css">',
			)
			// Root-relative asset links: a place's page (/lugar/zulia/maracaibo) is two folders deep.
			.replace(/(href|src)="\.\//g, '$1="/')
			// The desk's workstation shell is a chunk of its own (not in a phone's first load); on a desk it is fetched with
			// the entry instead of after it (measured on the slow profile at 1440 px: data on screen 1 s later without).
			.replace("</head>", `${deskPreload()}</head>`)
			// The first API requests start with the HTML, not after the script (lib/first-requests.ts).
			.replace(
				/(<meta charset="[^"]*"\s*\/?>)/,
				`$1${FIRST_REQUESTS.map((u) => `<link rel="preload" href="${u}" as="fetch" crossorigin="anonymous" fetchpriority="low">`).join("")}`,
			),
	);
}
// The service worker is stamped with this build: a new build installs a new worker (and cache). It installs with
// the files index.html loads, then fetches the chunks loaded on demand in the background, so every page and panel
// opens offline. The municipal outlines (44 KiB gzip, only drawn on a state zoom, and the map works without them)
// are left to be cached when first used.
{
	const html = await Bun.file(join(outdir, "index.html")).text();
	const files = result.outputs
		.map((o) => `/${relative(outdir, o.path).split("\\").join("/")}`)
		.filter((f) => f !== "/index.html")
		.sort();
	const build = Bun.hash(`${files.join("\n")}\n${html}`).toString(36);
	const inHtml = (f: string) => html.includes(`"./${f.slice(1)}"`) || html.includes(`"${f}"`);
	// The desk's shell is linked from the HTML (a modulepreload for wide screens) but is not part of a phone's page:
	// it is precached with the other on-demand chunks, after the first data, not at install.
	const desk = (f: string) => /^\/Workstation-[a-z0-9]+\.js$/.test(f);
	const shell = files.filter((f) => inHtml(f) && !desk(f));
	const lazy = files.filter((f) => !shell.includes(f) && !f.startsWith("/municipalities.gen-"));
	const swPath = join(outdir, "sw.js");
	const sw = await Bun.file(swPath).text();
	for (const marker of ['"__BUILD__"', "/*__SHELL__*/ []", "/*__LAZY__*/ []"]) {
		if (!sw.includes(marker)) throw new Error(`sw.js: build marker ${marker} missing`);
	}
	// The page says which build it runs to the worker, which keeps the previous build's cache until no tab runs it.
	await Bun.write(
		join(outdir, "index.html"),
		html.replace("</head>", `<meta name="vigia-build" content="${build}"></head>`),
	);
	await Bun.write(
		swPath,
		sw
			.replace('"__BUILD__"', JSON.stringify(build))
			.replace("/*__SHELL__*/ []", JSON.stringify(shell))
			.replace("/*__LAZY__*/ []", JSON.stringify(lazy)),
	);
}
let gz = 0;
let br = 0;
let lazyGz = 0;
// The worker counts as on demand: it is fetched when the report sheet opens.
for (const out of [...result.outputs, { path: powOut.path, kind: "chunk" as const }]) {
	const bytes = new Uint8Array(await Bun.file(out.path).arrayBuffer());
	const g = gzipSync(bytes, { level: 9 }).length;
	const b = brotliCompressSync(bytes).length;
	gz += g;
	br += b;
	if (out.kind === "chunk") lazyGz += g;
	if (!process.env.QUIET)
		console.log(
			`${relative(root, out.path).padEnd(44)} ${String(bytes.length).padStart(8)} B  gz ${String(g).padStart(7)}  br ${String(b).padStart(7)}`,
		);
}
console.log(
	`web: ${result.outputs.length} files, gzip ${(gz / 1024).toFixed(1)} KiB (first load ${((gz - lazyGz) / 1024).toFixed(1)}, on demand ${(lazyGz / 1024).toFixed(1)}), brotli ${(br / 1024).toFixed(1)} KiB`,
);
