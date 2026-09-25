import { signal } from "@preact/signals";

export type Route = "wall" | "status" | "guide" | "sources" | "ai" | "brief" | "bloqueos";
const PATHS: Record<Route, string> = {
	wall: "/",
	status: "/estado",
	guide: "/guia",
	sources: "/fuentes",
	ai: "/ia",
	brief: "/resumen",
	bloqueos: "/bloqueos",
};

function parse(path: string): Route {
	const hit = (Object.entries(PATHS) as [Route, string][]).find(
		([, p]) => p === path.replace(/\/+$/, "") || (p === "/" && path === "/"),
	);
	return hit?.[0] ?? "wall";
}

export const route = signal<Route>(parse(location.pathname));

export function go(next: Route): void {
	if (route.value === next) return;
	history.pushState(null, "", PATHS[next]);
	route.value = next;
	window.scrollTo({ top: 0 });
}

export function href(r: Route): string {
	return PATHS[r];
}

addEventListener("popstate", () => {
	route.value = parse(location.pathname);
});

/** Same-page navigation for <a> without reloading. */
export function link(r: Route) {
	return {
		href: PATHS[r],
		onClick: (e: MouseEvent) => {
			if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
			e.preventDefault();
			go(r);
		},
	};
}

/**
 * View state in the query string (?capa=internet&estado=VE-K&t=…), so a link opens exactly the view it was copied
 * from. Writes use replaceState (no history entry per click) and are debounced so dragging a slider does not spam the
 * browser. Only the wall carries view state; other pages keep a clean URL.
 */
export function readQuery(): URLSearchParams {
	return new URLSearchParams(location.search);
}

let pendingQuery: Record<string, string | null> = {};
let queryTimer: ReturnType<typeof setTimeout> | null = null;

/** Merges `patch` into the query string 500 ms after the last call; null removes a key. */
export function writeQuery(patch: Record<string, string | null>, delayMs = 500): void {
	pendingQuery = { ...pendingQuery, ...patch };
	if (queryTimer) clearTimeout(queryTimer);
	queryTimer = setTimeout(flushQuery, delayMs);
}

export function flushQuery(): void {
	if (queryTimer) clearTimeout(queryTimer);
	queryTimer = null;
	if (route.value !== "wall") {
		pendingQuery = {};
		return;
	}
	const q = readQuery();
	for (const [k, v] of Object.entries(pendingQuery)) {
		if (v === null) q.delete(k);
		else q.set(k, v);
	}
	pendingQuery = {};
	const search = q.toString();
	const next = `${location.pathname}${search ? `?${search.replace(/%3A/g, ":")}` : ""}${location.hash}`;
	if (next !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(null, "", next);
}

/** The current page's full address with its view state, for "Copiar enlace". */
export function shareUrl(): string {
	flushQuery();
	return location.href;
}
