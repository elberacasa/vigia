import { signal } from "@preact/signals";
import { entityIdFromPath, entityPath } from "./entity-route.ts";
import { MODULE_BY_ID, type ModuleId, moduleByPath } from "./modules.ts";

/**
 * Client routes. "wall" is the room itself: on a desk it opens on a module (/, /dinero, /internet…, lib/modules.ts),
 * on a phone it is the one scrolling list. "entity" is an entity's page (lib/entity-route.ts): a place
 * (/lugar/zulia/maracaibo/…), a facility (/infra/…), a network (/red/…), an institution (/institucion/…), an
 * outlet (/medio/…) or a public camera (/camara/…).
 */
export type Route = "wall" | "status" | "guide" | "sources" | "ai" | "brief" | "bloqueos" | "entity";
export type PageRoute = Exclude<Route, "entity">;
const PATHS: Record<PageRoute, string> = {
	wall: "/",
	status: "/estado",
	guide: "/guia",
	sources: "/fuentes",
	ai: "/ia",
	brief: "/resumen",
	bloqueos: "/bloqueos",
};

interface Parsed {
	route: Route;
	module: ModuleId;
	/** The entity id of an entity page ("ve.zulia", "infra.guri"); null elsewhere. */
	entity: string | null;
}

/** Exported for tests: what an address opens. Unknown addresses open the room, as before. */
export function parsePath(path: string): Parsed {
	const clean = path.replace(/\/+$/, "") || "/";
	const mod = moduleByPath(clean);
	if (mod) return { route: "wall", module: mod.id, entity: null };
	const entity = entityIdFromPath(clean);
	if (entity) return { route: "entity", module: "situacion", entity };
	const hit = (Object.entries(PATHS) as [PageRoute, string][]).find(([, p]) => p === clean);
	return { route: hit?.[0] ?? "wall", module: "situacion", entity: null };
}

const first = parsePath(location.pathname ?? "/");
export const route = signal<Route>(first.route);
/** The desk's open module (kept while a secondary page is open, so "back to the room" returns to it). */
export const moduleId = signal<ModuleId>(first.module);
/** The entity page's id ("ve.zulia.maracaibo", "infra.guri"); null on other routes. */
export const entityId = signal<string | null>(first.entity);
/** The open entity page's name, for the command bar (set by the page once it knows it). */
export const entityTitle = signal<string | null>(null);

function apply(p: Parsed): void {
	route.value = p.route;
	if (p.route === "wall") moduleId.value = p.module;
	if (p.entity !== entityId.value) entityTitle.value = null;
	entityId.value = p.entity;
}

/**
 * A new page starts at its top: the window on a phone, and the workstation's own scroller on the desk (`.ws__page`
 * scrolls inside a fixed viewport, so resetting the window alone left the next page scrolled down).
 */
export function scrollToTop(): void {
	window.scrollTo({ top: 0 });
	for (const el of document.querySelectorAll<HTMLElement>(".ws__page")) el.scrollTop = 0;
}

function push(path: string, keepQuery: boolean): void {
	flushQuery();
	history.pushState(null, "", `${path}${keepQuery ? location.search : ""}`);
	apply(parsePath(path));
	scrollToTop();
}

export function go(next: PageRoute): void {
	if (route.value === next && next !== "wall") return;
	if (next === "wall") {
		const path = MODULE_BY_ID.get(moduleId.value)?.path ?? "/";
		if (route.value === "wall" && location.pathname === path) return;
		push(path, route.value === "wall");
		return;
	}
	push(PATHS[next], false);
}

/** Opens a module of the room; the view state (selected place, layer, time) comes along in the query string. */
export function openModule(id: ModuleId): void {
	if (route.value === "wall" && moduleId.value === id) return;
	push(MODULE_BY_ID.get(id)?.path ?? "/", route.value === "wall");
}

export function placePath(slugs: readonly string[]): string {
	return `/lugar/${slugs.join("/")}`;
}

export function openPlace(slugs: readonly string[]): void {
	openPath(placePath(slugs));
}

/** Opens an entity's page (no-op for an id without an address). */
export function openEntity(id: string): void {
	const path = entityPath(id);
	if (path) openPath(path);
}

function openPath(path: string): void {
	if (location.pathname === path) return;
	push(path, false);
}

/** Swaps the address for its canonical form without a history entry (an old municipality slug, for one). */
export function replacePath(path: string): void {
	if (location.pathname === path) return;
	history.replaceState(null, "", path);
	apply(parsePath(path));
}

export function href(r: PageRoute): string {
	return PATHS[r];
}

addEventListener("popstate", () => {
	apply(parsePath(location.pathname));
});

function plain(e: MouseEvent): boolean {
	return !(e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0);
}

/** Same-page navigation for <a> without reloading. */
export function link(r: PageRoute) {
	return {
		href: PATHS[r],
		onClick: (e: MouseEvent) => {
			if (!plain(e)) return;
			e.preventDefault();
			go(r);
		},
	};
}

export function moduleLink(id: ModuleId) {
	return {
		href: MODULE_BY_ID.get(id)?.path ?? "/",
		onClick: (e: MouseEvent) => {
			if (!plain(e)) return;
			e.preventDefault();
			openModule(id);
		},
	};
}

export function placeLink(slugs: readonly string[]) {
	return pathLink(placePath(slugs));
}

/** A link to an entity's page; a plain span-like anchor without href when the id has no address. */
export function entityLink(id: string) {
	return pathLink(entityPath(id) ?? "/");
}

function pathLink(path: string) {
	return {
		href: path,
		onClick: (e: MouseEvent) => {
			if (!plain(e)) return;
			e.preventDefault();
			openPath(path);
		},
	};
}

/**
 * View state in the query string (?capa=internet&estado=VE-K&t=…), so a link opens exactly the view it was copied
 * from. Writes use replaceState (no history entry per click) and are debounced so dragging a slider does not spam the
 * browser. Only the room carries view state; other pages keep a clean URL.
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
