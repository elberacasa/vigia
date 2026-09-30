import { useEffect, useMemo, useState } from "preact/hooks";
import { muniChoices } from "../lib/crowd-places.ts";
import { type CrowdView, crowdPlaces } from "../lib/crowd-view.ts";
import { addStyles } from "../lib/css.ts";
import { panels, tick, wantPanel } from "../lib/data.ts";
import { int } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { PLACES } from "../lib/places.gen.ts";
import crowdCss from "../styles/crowd.css?inline";
import { pathBox } from "./project.ts";
import { replaying } from "./view.ts";

addStyles(crowdCss);

/*
 * "Reportes de usuarios" on the map: the municipalities people reported from in the last two hours, as hatched
 * outlines with their count of answers, never a measured layer's fill or colours (a report is not a measurement).
 * The outlines (≈ 45 KB gzip) and the view load only when the layer is on. A press on a municipality works as
 * anywhere on land: the inspector says what is there, with its reports among the other signals.
 */

type Muni = { code: string; name: string; state: string; d: string };
let outlines: Promise<readonly Muni[]> | null = null;

function useOutlines(): readonly Muni[] | null {
	const [m, setM] = useState<readonly Muni[] | null>(null);
	useEffect(() => {
		outlines ??= import("./municipalities.gen.ts").then((x) => x.MUNICIPALITIES);
		let alive = true;
		outlines.then(
			(all) => alive && setM(all),
			() => {
				outlines = null;
			},
		);
		return () => {
			alive = false;
		};
	}, []);
	return m;
}

let codeById: Map<string, string> | null = null;
/** A municipality's INE code (the outlines') from its ontology id (the view's), through the page's names index. */
function codeOf(id: string): string | undefined {
	codeById ??= new Map(muniChoices(PLACES).map((m) => [m.id, m.code]));
	return codeById.get(id);
}

export function useCrowdView(): CrowdView | undefined {
	useEffect(() => {
		wantPanel("crowd").catch(() => {});
	}, []);
	return panels.value.crowd as CrowdView | undefined;
}

export function CrowdLayer() {
	const view = useCrowdView();
	const munis = useOutlines();
	const l = lang.value;
	const n = tick.value;
	const places = useMemo(() => (view ? crowdPlaces(view.municipalities, l, n) : []), [view, l, n]);
	const shapes = useMemo(() => {
		if (!munis) return [];
		const byCode = new Map(munis.map((m) => [m.code, m]));
		return places.flatMap((p) => {
			const m = byCode.get(codeOf(p.entity) ?? "");
			if (!m) return [];
			const box = pathBox(m.d);
			return [{ p, m, x: box[0] + box[2] / 2, y: box[1] + box[3] / 2 }];
		});
	}, [munis, places]);
	return (
		<g class="layer-crowd">
			<defs>
				<pattern
					id="crowd-hatch"
					width="6"
					height="6"
					patternUnits="userSpaceOnUse"
					patternTransform="rotate(-45)"
				>
					<line x1="0" y1="0" x2="0" y2="6" class="crowd-hatch" />
				</pattern>
			</defs>
			{shapes.map(({ p, m, x, y }) => (
				<g key={p.entity}>
					<path d={m.d} class="crowd-muni">
						<title>
							{`${p.name}: ${p.items.map((it) => `${it.serviceName[l]}, ${it.text[l]}`).join("; ")} (${t("reportes de usuarios, sin verificar", "user reports, unverified")})`}
						</title>
					</path>
					<g
						class="crowd-count"
						style={{ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(var(--zk, 1))` }}
					>
						<rect x={-18} y={-13} width={36} height={26} rx={3} />
						<text y={6}>{int(p.answers, l)}</text>
					</g>
				</g>
			))}
		</g>
	);
}

/** The layer's key: what the hatching and the number mean, and what they are not. */
export function CrowdLegend() {
	const view = panels.value.crowd as CrowdView | undefined;
	const l = lang.value;
	if (replaying.value !== null)
		return (
			<div class="crowd-key">
				<span class="note">
					{t(
						"Reportes de usuarios: solo en vivo (las últimas 2 h), no en la hora que muestra el mapa.",
						"User reports: live only (the last 2 h), not at the hour the map shows.",
					)}
				</span>
			</div>
		);
	return (
		<div class="crowd-key">
			<span>
				<svg width="22" height="12" viewBox="0 0 22 12" aria-hidden="true">
					<defs>
						<pattern
							id="crowd-hatch-key"
							width="5"
							height="5"
							patternUnits="userSpaceOnUse"
							patternTransform="rotate(-45)"
						>
							<line x1="0" y1="0" x2="0" y2="5" class="crowd-hatch" />
						</pattern>
					</defs>
					<rect x="0.5" y="0.5" width="21" height="11" class="crowd-muni crowd-muni--key" />
				</svg>
				{t("municipio con reportes de usuarios (2 h)", "municipality with user reports (2 h)")}
			</span>
			<span>
				{t("número: respuestas, no personas ni porcentaje", "number: answers, not people or a percentage")}
			</span>
			<span class="note">
				{view
					? view.counts.reports
						? t(
								`${int(view.counts.municipalities, l)} municipios; reportes sin verificar, nunca una medición.`,
								`${int(view.counts.municipalities, l)} municipalities; unverified reports, never a measurement.`,
							)
						: t(
								"Ningún reporte en 2 h: no significa que haya servicio.",
								"No report in 2 h: it does not mean there is service.",
							)
					: t("Cargando…", "Loading…")}
			</span>
		</div>
	);
}
