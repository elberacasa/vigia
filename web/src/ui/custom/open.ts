import { signal } from "@preact/signals";

/** Which tab of the "Personalizar" sheet is open; null when closed. The sheet itself is a lazy chunk. */
export type CustomTab = "views" | "panels" | "sources" | "alerts";
export const customizeTab = signal<CustomTab | null>(null);

export function openCustomize(tab: CustomTab = "views"): void {
	customizeTab.value = tab;
}

// A link can open the sheet at a tab: ?personalizar=vistas|paneles|fuentes|alertas (e.g. from the setup guide).
const SLUGS: Record<string, CustomTab> = {
	vistas: "views",
	paneles: "panels",
	fuentes: "sources",
	alertas: "alerts",
};
try {
	const asked = new URLSearchParams(location.search).get("personalizar");
	if (asked && SLUGS[asked]) customizeTab.value = SLUGS[asked];
} catch {
	// No location (tests): nothing to open.
}

/** Closes the sheet and drops ?personalizar= so a reload does not reopen it. */
export function closeCustomize(): void {
	customizeTab.value = null;
	try {
		const q = new URLSearchParams(location.search);
		if (!q.has("personalizar")) return;
		q.delete("personalizar");
		const search = q.toString();
		history.replaceState(null, "", `${location.pathname}${search ? `?${search}` : ""}${location.hash}`);
	} catch {
		// ignore
	}
}
