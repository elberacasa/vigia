import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { type FeedState, healthById, metaById, now } from "../lib/data.ts";
import { ago } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";

export interface SourceRef {
	/** Adapter id. */
	feed: string;
	/** When the figure is true according to the source. */
	observedAt: number;
	/** Link to the original. */
	url?: string | undefined;
	/** Optional extra, e.g. "mediana de 20 anuncios". */
	detail?: string | undefined;
}

/** The sheet with the full provenance of one figure; one at a time (ui/SourceSheet.tsx, loaded on first open). */
export const openSource = signal<SourceRef | null>(null);

/** What a panel's "?" opens: how to read it, the rules behind it, and every source it draws on. */
export interface MethodRef {
	title: string;
	question?: string | undefined;
	feeds: readonly string[];
	body: ComponentChildren;
}
export const openMethod = signal<MethodRef | null>(null);

export function stateLabel(state: FeedState): string {
	switch (state) {
		case "ok":
			return t("En vivo", "Live");
		case "stale":
			return t("Con retraso", "Delayed");
		case "degraded":
			return t("Reintentando", "Retrying");
		case "failing":
			return t("Sin conexión con la fuente", "Source unreachable");
		case "locked":
			return t("Necesita clave", "Needs a key");
		case "off":
			return t("Apagada", "Off");
		case "pending":
			return t("Cargando", "Loading");
	}
}

export function StateBadge({ state }: { state: FeedState }) {
	return <span class={`badge badge--${state}`}>{stateLabel(state)}</span>;
}

/** "BCV · hace 3 h", colour by the feed's health; opens the provenance sheet. */
export function SourceTag({ source, label }: { source: SourceRef; label?: string }) {
	const meta = metaById.value.get(source.feed);
	const health = healthById.value.get(source.feed);
	const state = health?.state ?? "pending";
	const age = ago(now.value - source.observedAt, lang.value);
	return (
		<button
			type="button"
			class={`source source--${state}`}
			onClick={() => {
				openSource.value = source;
			}}
			aria-label={t(
				`Fuente: ${meta?.provider ?? source.feed}, ${age}. Ver detalles`,
				`Source: ${meta?.provider ?? source.feed}, ${age}. Details`,
			)}
		>
			<span class={`dot dot--${state}`} aria-hidden="true" />
			<span class="source__provider">{label ?? meta?.provider ?? source.feed}</span>
			<span class="source__age">{age}</span>
		</button>
	);
}
