import { t } from "./i18n.ts";

/**
 * After an upgrade, a tab opened on the previous build asks for chunks that may no longer exist (review 4, M8).
 * The server keeps the previous build's chunks for a week and the worker keeps its cache, but when a chunk still
 * cannot be fetched while online, the tab reloads once onto the new build, with a notice, instead of leaving panels
 * that say "No se pudo cargar". Offline it does not reload (the retry buttons stay), and a reload is not repeated
 * within five minutes (guarded in sessionStorage), so a broken server never makes a reload loop.
 */

const KEY = "vigia:chunk-reload";
export const RELOAD_GUARD_MS = 5 * 60_000;

/** A failed dynamic import, as Chromium, Firefox and Safari word it. */
export function isChunkError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
	return /dynamically imported module|Importing a module script failed|error loading dynamically imported/i.test(
		message,
	);
}

/** Whether to reload now: online, a chunk error, and no reload in the last five minutes (null: no storage). */
export function shouldReload(
	err: unknown,
	online: boolean,
	lastReloadAt: number | null,
	now: number,
): boolean {
	if (!online || !isChunkError(err) || lastReloadAt === null) return false;
	return now - lastReloadAt >= RELOAD_GUARD_MS;
}

function lastReload(): number | null {
	try {
		return Number(sessionStorage.getItem(KEY) ?? "0") || 0;
	} catch {
		// No storage, no guard: never reload automatically.
		return null;
	}
}

let reloading = false;

/** Reloads onto the new build with a notice, when `shouldReload` says so. True when a reload is under way. */
export function recoverFromChunkError(err: unknown): boolean {
	if (reloading) return true;
	if (!shouldReload(err, navigator.onLine, lastReload(), Date.now())) return false;
	try {
		sessionStorage.setItem(KEY, String(Date.now()));
	} catch {
		return false;
	}
	reloading = true;
	const note = document.createElement("div");
	note.setAttribute("role", "status");
	note.className = "update-notice";
	note.textContent = t(
		"Vigía se actualizó. Recargando la página para traer la versión nueva…",
		"Vigía was updated. Reloading the page to get the new version…",
	);
	Object.assign(note.style, {
		position: "fixed",
		left: "50%",
		bottom: "calc(80px + env(safe-area-inset-bottom, 0px))",
		transform: "translateX(-50%)",
		zIndex: "1000",
		maxWidth: "calc(100vw - 32px)",
		padding: "10px 14px",
		borderRadius: "8px",
		background: "var(--surface-3, #222)",
		color: "var(--text, #fff)",
		border: "1px solid var(--line, #444)",
		font: "14px/1.4 var(--font-ui, system-ui)",
		boxShadow: "0 4px 16px rgb(0 0 0 / 0.3)",
	});
	document.body.append(note);
	setTimeout(() => location.reload(), 1500);
	return true;
}

// Dynamic imports whose failure nobody handles (sheets, dialogs, share cards) recover the same way.
if (typeof window !== "undefined")
	window.addEventListener("unhandledrejection", (e) => {
		if (recoverFromChunkError(e.reason)) e.preventDefault();
	});
