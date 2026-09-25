import { signal } from "@preact/signals";

/** Per-device display preferences (localStorage; the page works without it). */
export type Theme = "system" | "dark" | "light";

function read(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}
function write(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// ignore
	}
}

const savedTheme = read("vigia:theme");
export const theme = signal<Theme>(savedTheme === "dark" || savedTheme === "light" ? savedTheme : "system");
export const reducedMotion = signal(read("vigia:motion") === "reduced");

function apply(): void {
	const root = document.documentElement;
	if (theme.value === "system") root.removeAttribute("data-theme");
	else root.dataset.theme = theme.value;
	if (reducedMotion.value) root.dataset.motion = "reduced";
	else root.removeAttribute("data-motion");
	const meta = document.querySelector('meta[name="theme-color"]');
	const light =
		theme.value === "light" ||
		(theme.value === "system" && matchMedia("(prefers-color-scheme: light)").matches);
	meta?.setAttribute("content", light ? "#f4f1ea" : "#07090e");
}

export function setTheme(next: Theme): void {
	theme.value = next;
	write("vigia:theme", next);
	apply();
}

export function setReducedMotion(on: boolean): void {
	reducedMotion.value = on;
	write("vigia:motion", on ? "reduced" : "full");
	apply();
}

apply();

/** Single-key shortcuts (/, L, Q, S, T, 1–9…) can be turned off (WCAG 2.1.4); Ctrl/⌘K and Esc always work. */
export const letterKeys = signal(read("vigia:letter-keys") !== "off");
export function setLetterKeys(on: boolean): void {
	letterKeys.value = on;
	write("vigia:letter-keys", on ? "on" : "off");
}

/**
 * Density: Cómodo (default), Compacto (tighter spacing, 13 px body) or Pared (a wall display seen from across a
 * room: larger type, panels open one at a time). ?pared=1 sets Pared for this visit without saving it.
 */
export type Density = "comodo" | "compacto" | "pared";
function readDensity(): Density {
	try {
		if (new URLSearchParams(location.search).get("pared") === "1") return "pared";
	} catch {
		// ignore
	}
	const saved = read("vigia:density");
	return saved === "compacto" || saved === "pared" ? saved : "comodo";
}
export const density = signal<Density>(readDensity());
function applyDensity(): void {
	if (density.value === "comodo") document.documentElement.removeAttribute("data-density");
	else document.documentElement.dataset.density = density.value;
}
applyDensity();

export function setDensity(next: Density): void {
	density.value = next;
	write("vigia:density", next);
	applyDensity();
}
