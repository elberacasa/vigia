import { signal } from "@preact/signals";

/** The desk shell's own view state, kept per device (the page works without storage). */
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
		// Storage off: the choice lasts for this visit.
	}
}

/** Folded by default on a small desk (under 1280 px the map needs the room); the reader's choice is kept. */
const savedInspector = read("vigia:ws:inspector");
export const inspectorOpen = signal(
	savedInspector === null ? matchMedia("(min-width: 1280px)").matches : savedInspector !== "off",
);
export const stripOpen = signal(read("vigia:ws:strip") !== "off");

export function toggleInspector(on = !inspectorOpen.value): void {
	inspectorOpen.value = on;
	write("vigia:ws:inspector", on ? "on" : "off");
}

export function toggleStrip(on = !stripOpen.value): void {
	stripOpen.value = on;
	write("vigia:ws:strip", on ? "on" : "off");
}
