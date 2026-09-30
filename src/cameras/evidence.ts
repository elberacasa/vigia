import type { Evidence } from "../intel/incidents.ts";
import { CAMERA_RULES } from "./rules.ts";

/**
 * A public camera whose city lights went dark (state.ts `nightReading` status "dark") as evidence for the incident
 * engine: family "camaras", which is join-only (it adds corroboration to a cut other families opened, and never
 * opens, promotes, names or keeps alive an incident on its own; src/intel/incidents.ts JOIN_ONLY).
 */

export const CAMERAS_SOURCE = "public-cams";

/** What the incident engine needs from one camera card (panels/cameras.ts). */
export type CameraDarkInput = {
	readonly id: string;
	readonly name: { readonly es: string; readonly en: string };
	readonly operator: { readonly name: string };
	readonly state: string | null;
	readonly entity: string | null;
	readonly night: {
		readonly status: string;
		readonly ratio: number | null;
		readonly baseline: number | null;
		readonly current: number | null;
		readonly nights: number;
		readonly darkSince: number | null;
		readonly darkLast: number | null;
		readonly darkStills: number;
		readonly refs: readonly { readonly series: string; readonly observedAt: number }[];
	};
};

const pct = (x: number) => `${Math.round(x * 100)} %`;

/** Pure: evidence for a dark camera in Venezuela, or null. */
export function cameraEvidence(c: CameraDarkInput, now: number): Evidence | null {
	const n = c.night;
	if (
		n.status !== "dark" ||
		!c.state ||
		!c.entity ||
		n.darkSince === null ||
		n.darkLast === null ||
		n.ratio === null
	)
		return null;
	if (now - n.darkLast > CAMERA_RULES.evidenceFreshMs) return null;
	return {
		id: `cam:dark:${c.id}`,
		family: "camaras",
		role: "signal",
		speaks: "power",
		feed: CAMERAS_SOURCE,
		es: `Cámara pública «${c.name.es}» (${c.operator.name}): luces de su vista al ${pct(n.ratio)} de su mediana de ${n.nights} noches anteriores a esta hora (${n.darkStills} imágenes seguidas; calculado por Vigía)`,
		en: `Public camera "${c.name.en}" (${c.operator.name}): lights in its view at ${pct(n.ratio)} of its median over ${n.nights} previous nights at this hour (${n.darkStills} stills in a row; computed by Vigía)`,
		at: n.darkSince,
		lastAt: n.darkLast,
		fetchedAt: n.darkLast,
		url: `/api/v1/entities/${c.entity}`,
		outlet: null,
		refs: n.refs.map((r) => ({ source: CAMERAS_SOURCE, series: r.series, observedAt: r.observedAt })),
	};
}
