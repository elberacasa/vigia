import { existsSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { decodeSegment } from "./uri.ts";

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
};

const HASHED = /-[a-z0-9]{8,}\.(js|css|woff2|svg|png|webp)$/;

function typeOf(path: string): string {
	const dot = path.lastIndexOf(".");
	return TYPES[dot === -1 ? "" : path.slice(dot)] ?? "application/octet-stream";
}

/**
 * Serves the built client. Hashed assets are cached for a year; index.html is revalidated. Unknown paths
 * without an extension fall back to index.html (client-side routes). Files come from the embedded bundle in a
 * compiled binary, otherwise from web/dist.
 */
export function staticServer(
	root: string,
	bundled: Readonly<Record<string, string>> = {},
): (path: string) => Promise<Response | null> {
	const embedded = new Map<string, Blob>(
		Object.entries(bundled).map(([path, file]) => [path, Bun.file(file)]),
	);
	const fromDisk = embedded.size === 0;
	if (fromDisk && !existsSync(join(root, "index.html"))) {
		console.warn(`[vigia] No hay cliente compilado en ${root}. Ejecuta: bun run build:web`);
	}

	const fromRoot = async (dir: string, path: string): Promise<Blob | null> => {
		const clean = normalize(path).replace(/^([/\\])+/, "");
		const full = join(dir, clean);
		if (!full.startsWith(dir + sep) && full !== dir) return null;
		const file = Bun.file(full);
		return (await file.exists()) ? file : null;
	};
	// The previous builds' hashed chunks (scripts/build-web.ts keeps them a week): a tab opened before an upgrade
	// can still load its panels (review 4, M8).
	const previous = `${root}-previous`;
	const load = async (path: string): Promise<Blob | null> => {
		if (!fromDisk) return embedded.get(path) ?? null;
		const file = await fromRoot(root, path);
		if (file || !HASHED.test(path) || path.includes("/", 1)) return file;
		return fromRoot(previous, path);
	};

	return async (rawPath) => {
		let path = decodeSegment(rawPath);
		if (path === null) return null;
		if (path.includes("\0") || path.includes("..")) return null;
		if (path === "/") path = "/index.html";
		let blob = await load(path);
		let served = path;
		if (!blob && !/\.[a-z0-9]+$/i.test(path)) {
			blob = await load("/index.html");
			served = "/index.html";
		}
		if (!blob) return null;
		const hashed = HASHED.test(served) || served.startsWith("/fonts/");
		const headers: Record<string, string> = {
			"content-type": typeOf(served),
			"cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
		};
		if (served === "/sw.js") headers["service-worker-allowed"] = "/";
		return new Response(blob, { headers });
	};
}
