import { signal } from "@preact/signals";
import type { Lang } from "./format.ts";

function initialLang(): Lang {
	try {
		const saved = localStorage.getItem("vigia:lang");
		if (saved === "es" || saved === "en") return saved;
	} catch {
		// ignore
	}
	return "es";
}

export const lang = signal<Lang>(initialLang());

export function setLang(next: Lang): void {
	lang.value = next;
	document.documentElement.lang = next;
	try {
		localStorage.setItem("vigia:lang", next);
	} catch {
		// ignore
	}
}

/** Inline bilingual text: t("Sismos", "Earthquakes"). Spanish is the source language. */
export function t(es: string, en: string): string {
	return lang.value === "es" ? es : en;
}
