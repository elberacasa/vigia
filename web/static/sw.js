// Vigía service worker: the app opens offline, including the parts that load on demand.
// - Every build stamps BUILD, SHELL and LAZY below (scripts/build-web.ts), so each build installs a new worker with
//   its own cache. The previous build's cache is kept (older ones are deleted on activation): a tab opened before
//   the upgrade still runs the previous build and asks for its chunks (review 4, M8). It is deleted once no open
//   tab runs it (checked at activation and whenever a tab says which build it runs), or at the next upgrade.
// - Install caches only the first-load files, so the worker is active (and a repeat visit instant) as soon as
//   possible on a slow link; the page then asks it to fetch the chunks loaded on demand, in the background.
// - Hashed assets and fonts are cache-first (they never change). The page shell is network-first, and only an
//   ok HTML response for an app route is kept as the shell: never /ahora.txt, an error page or an API reply.
// - The API is never cached here: the app keeps its own last-known values with their real age.
const BUILD = "__BUILD__";
/** The files index.html loads. */
const SHELL = /*__SHELL__*/ [];
/** The chunks loaded on demand (panel bodies, pages, sheets, their styles). */
const LAZY = /*__LAZY__*/ [];
const CACHE = `vigia-${BUILD}`;
const FONTS = ["/fonts/archivo-2.woff2", "/fonts/chivo-mono-1.woff2"];

self.addEventListener("install", (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			const shell = await fetch("/", { cache: "no-store", headers: { accept: "text/html" } });
			if (isShell(shell)) await cache.put("/", shell);
			// One failed file must not block the others (it is fetched and cached when first used).
			await Promise.all(SHELL.map((a) => cache.add(a).catch(() => {})));
			await self.skipWaiting();
		})(),
	);
});

/** Builds, newest first, in a small list kept in its own cache. */
const META = "vigia-meta";
async function builds() {
	const hit = await (await caches.open(META)).match("/builds");
	return hit ? hit.json().catch(() => []) : [];
}
async function saveBuilds(list) {
	await (await caches.open(META)).put("/builds", new Response(JSON.stringify(list)));
}

/** Builds the open tabs run, as they last said (a "build:<id>" message from web/src/main.tsx). */
const running = new Map();

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const list = [BUILD, ...(await builds()).filter((b) => b !== BUILD)].slice(0, 2);
			await saveBuilds(list);
			const keep = new Set(list.map((b) => `vigia-${b}`));
			const keys = await caches.keys();
			await Promise.all(
				keys.filter((k) => k.startsWith("vigia-") && k !== META && !keep.has(k)).map((k) => caches.delete(k)),
			);
			await self.clients.claim();
		})(),
	);
});

/** Deletes the previous build's cache once every open tab says it runs this build. */
async function dropUnusedPrevious() {
	const tabs = await self.clients.matchAll({ type: "window" });
	if (!tabs.length || tabs.some((c) => running.get(c.id) !== BUILD)) return;
	const list = await builds();
	for (const b of list.filter((x) => x !== BUILD)) await caches.delete(`vigia-${b}`);
	await saveBuilds([BUILD]);
}

/** The on-demand chunks and the fonts this cache does not hold yet, one at a time (a background download on a slow link). */
async function precacheLazy() {
	const cache = await caches.open(CACHE);
	for (const path of [...LAZY, ...FONTS]) {
		if (await cache.match(path)) continue;
		await cache.add(path).catch(() => {});
	}
}

// The page sends "precache" once this worker controls it (web/src/main.tsx).
self.addEventListener("message", (event) => {
	if (event.data === "precache") event.waitUntil(precacheLazy());
	if (typeof event.data === "string" && event.data.startsWith("build:") && event.source) {
		running.set(event.source.id, event.data.slice(6));
		event.waitUntil(dropUnusedPrevious());
	}
});

/** An app route: a path without a file extension, outside /api/ (client-side routes all serve the shell). */
function isAppRoute(url) {
	return !url.pathname.startsWith("/api/") && !/\.[a-z0-9]+$/i.test(url.pathname);
}

function isShell(response) {
	return response.ok && (response.headers.get("content-type") ?? "").startsWith("text/html");
}

self.addEventListener("fetch", (event) => {
	const request = event.request;
	const url = new URL(request.url);
	// The server's own pages (API docs, printable report, metrics, text report) are not the app: never cache them
	// as the shell.
	const serverPage = /^\/(api|informe|metrics|ahora\.txt)(\/|$)/.test(url.pathname);
	if (request.method !== "GET" || url.origin !== location.origin || serverPage) return;
	const immutable =
		/-[a-z0-9]{8,}\.(js|css|svg|png|webp)$/.test(url.pathname) || url.pathname.startsWith("/fonts/");
	if (immutable) {
		event.respondWith(
			caches.match(request).then(
				(hit) =>
					hit ||
					fetch(request).then((response) => {
						if (response.ok) {
							const copy = response.clone();
							caches.open(CACHE).then((c) => c.put(request, copy));
						}
						return response;
					}),
			),
		);
		return;
	}
	if (request.mode === "navigate" && isAppRoute(url)) {
		event.respondWith(
			fetch(request)
				.then((response) => {
					if (isShell(response)) {
						const copy = response.clone();
						caches.open(CACHE).then((c) => c.put("/", copy));
					}
					return response;
				})
				.catch(() => caches.match("/").then((hit) => hit || Response.error())),
		);
	}
});

// An alert notification (lib/alerts.ts): bring the open Vigía tab forward, or open one.
self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
			const open = list.find((c) => new URL(c.url).origin === location.origin);
			return open ? open.focus() : self.clients.openWindow("/");
		}),
	);
});
