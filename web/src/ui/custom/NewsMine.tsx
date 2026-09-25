import { signal } from "@preact/signals";
import { addStyles } from "../../lib/css.ts";
import { panels } from "../../lib/data.ts";
import { t } from "../../lib/i18n.ts";
import { newsFiltered, resetPanelPrefs } from "../../lib/panelprefs.ts";
import css from "../../styles/custom-news.css?inline";
import { openCustomize } from "./open.ts";

addStyles(css);

/**
 * The news panel's two small additions, kept out of News.tsx: the "Vigía / Mis fuentes" switch (only when the
 * reader added feeds), and the chip that says the list is filtered by the reader's settings.
 */

export const newsSource = signal<"all" | "mine">("all");

interface MineView {
	feeds?: { id: string }[];
}

export function mineCount(): number {
	return (panels.value["user-news"] as MineView | undefined)?.feeds?.length ?? 0;
}

/** Which news view the panel shows now ("mine" falls back to all once the reader has removed every feed). */
export function newsViewId(): "news" | "user-news" {
	return newsSource.value === "mine" && mineCount() > 0 ? "user-news" : "news";
}

export function NewsSourceTabs() {
	const n = mineCount();
	if (!n) return null;
	const mine = newsViewId() === "user-news";
	return (
		<fieldset class="segmented news-source">
			<legend class="sr-only">{t("Qué medios", "Which outlets")}</legend>
			<button type="button" aria-pressed={!mine} onClick={() => (newsSource.value = "all")}>
				{t("Medios de Vigía", "Vigía's outlets")}
			</button>
			<button type="button" aria-pressed={mine} onClick={() => (newsSource.value = "mine")}>
				{t("Mis fuentes", "My sources")} <span class="data">{n}</span>
			</button>
		</fieldset>
	);
}

/** Says, on the panel itself, that the reader's settings hide part of the list; one tap undoes it. */
export function NewsFilterChip() {
	if (!newsFiltered.value) return null;
	return (
		<p class="custom-filter note">
			<span>{t("Filtrado por tus ajustes.", "Filtered by your settings.")}</span>{" "}
			<button type="button" class="link-button" onClick={() => openCustomize("panels")}>
				{t("Cambiar", "Change")}
			</button>{" "}
			·{" "}
			<button type="button" class="link-button" onClick={() => resetPanelPrefs("news")}>
				{t("Ver todo", "Show all")}
			</button>
		</p>
	);
}

export function MineTag() {
	return <span class="tag tag--mine">{t("añadida por ti", "added by you")}</span>;
}

/** The foot line under "Mis fuentes": what these are, and what they never change. */
export function MineFoot({ reporting, total, items }: { reporting: number; total: number; items: number }) {
	return (
		<>
			<span>
				{t(
					`${reporting} de tus ${total} fuentes publicaron en 24 h · ${items} titulares`,
					`${reporting} of your ${total} sources published in 24 h · ${items} headlines`,
				)}
			</span>
			<span>
				{t(
					"Fuentes que añadiste tú: Vigía no las revisó. Se agrupan y etiquetan con las mismas reglas, pero no cuentan en los totales, el mapa, los incidentes ni el resumen.",
					"Sources you added: Vigía has not reviewed them. They are grouped and tagged by the same rules, but never count in the totals, the map, the incidents or the brief.",
				)}
			</span>
		</>
	);
}
