import {
	type AlertSplit,
	type AlertsWeek,
	GFW_HOME,
	type GfwAlerts,
	gfwAlerts,
	WEEKS,
} from "../adapters/gfw-alerts/index.ts";
import type { Store } from "../core/store.ts";
import { municipalities, stateByIso } from "../geo/index.ts";
import type { Panel } from "../server/panels.ts";

/**
 * "¿Dónde se está perdiendo bosque?" Global Forest Watch's integrated disturbance alerts as the `gfw-alerts` adapter
 * sums them by week: the country's last eight weeks (natural forest by confidence, other vegetation apart), the
 * states, municipalities and protected areas with most alerts in natural forest over the last four ended weeks,
 * and the newest week (still filling in). Hectares are GFW's alert areas added up by Vigía; an alert is a detected
 * disturbance (clearing, mining, fire, flooding, drought), not a confirmed loss.
 */

const DAY = 86_400_000;
export const RECENT_WEEKS = 4;

export const LABEL = "Alertas de perturbación en bosque natural (Global Forest Watch, alertas integradas)";
export const METHOD =
	"calculado por Vigía: suma semanal (lunes a domingo, UTC) de las hectáreas de alerta que publica GFW, separadas por confianza y por si el píxel es bosque natural (mapa SBTN Natural Forests)";
export const CAVEAT =
	"Una alerta es una perturbación detectada por satélite (tala, minería, fuego, inundación, sequía), no una pérdida confirmada. Desde 2025 incluyen DIST-ALERT, que vigila toda la vegetación: fuera del bosque natural dominan sabanas, cultivos y matorral seco (Apure, Falcón, Lara), por eso se muestran aparte. Las alertas recientes suben de confianza con nuevas pasadas; la semana en curso todavía se llena.";
export const PLACES_NOTE =
	"GFW agrupa por límites GADM, que no son los oficiales: los estados coinciden en 84–99 % de su área; un municipio GADM se enlaza al oficial solo si el 80 % de su área cae en él y, además, los nombres coinciden o cubre el 80 % del oficial (142 de 338); si no, se muestra con su nombre GADM. Áreas protegidas (WDPA): cada semana se guardan las 50 con más alertas en bosque natural, así que la suma de cuatro semanas es un mínimo; algunas se solapan (un parque dentro de una reserva) y nunca se suman entre sí.";

export type Hectares = { nominal: number; high: number; highest: number; total: number };
export type ForestSplit = { forest: Hectares; other: Hectares };

export type ForestView = {
	now: number;
	label: string;
	method: string;
	caveat: string;
	placesNote: string;
	feed: string;
	attribution: string;
	sourceUrl: string;
	/** GFW table version of the newest data, e.g. "v20260929", and when it was fetched. */
	version: string | null;
	fetchedAt: number | null;
	stale: boolean;
	/** The last WEEKS weeks, oldest first. */
	/** `ended: false` = the week is still running (hatched); ended weeks still grow as GFW adds late alerts. */
	weeks: (ForestSplit & { week: string; ended: boolean })[];
	/** Weeks summed below: the last RECENT_WEEKS ended weeks. */
	recent: { from: string; to: string; weeks: number };
	venezuela: ForestSplit;
	states: (ForestSplit & { iso: string; name: string })[];
	/** Top 25 by natural-forest hectares. */
	municipalities: (ForestSplit & {
		gadmId: string;
		name: string;
		/** Official P-code when linked (≥ 80 % overlap), else null (the name is GADM's). */
		code: string | null;
		state: string;
		stateName: string;
	})[];
	/**
	 * Top 25 by natural-forest hectares (WDPA; overlapping areas are not summed anywhere). WDPA lists some areas twice
	 * under the same name (Cuenca Hidrográfica del Río Pedregal: ids 20092 and 101161, 4,658 ha each): those are one
	 * row with every id and the larger figure, never the sum.
	 */
	protectedAreas: (ForestSplit & { wdpaIds: string[]; name: string; iucn: string | null })[];
};

const r1 = (v: number) => Math.round(v * 10) / 10;
function hectares(t: readonly number[]): Hectares {
	const [nominal = 0, high = 0, highest = 0] = t;
	return { nominal: r1(nominal), high: r1(high), highest: r1(highest), total: r1(nominal + high + highest) };
}
const split = (s: AlertSplit): ForestSplit => ({ forest: hectares(s.forestHa), other: hectares(s.otherHa) });

function addInto(acc: [number, number, number][], s: AlertSplit): void {
	const [f, o] = acc;
	if (!f || !o) return;
	for (let i = 0; i < 3; i++) {
		f[i] = (f[i] ?? 0) + (s.forestHa[i] ?? 0);
		o[i] = (o[i] ?? 0) + (s.otherHa[i] ?? 0);
	}
}
const zero = (): [number, number, number][] => [
	[0, 0, 0],
	[0, 0, 0],
];
const fromAcc = (a: [number, number, number][]): ForestSplit => ({
	forest: hectares(a[0] ?? []),
	other: hectares(a[1] ?? []),
});

type Row = { series: string; observedAt: number; fetchedAt: number; value: GfwAlerts };

/** Pure: the view from the newest revision of each stored week. */
export function forestViewOf(
	rows: readonly Row[],
	now: number,
): Omit<ForestView, "feed" | "attribution" | "sourceUrl"> {
	const byWeek = new Map<string, Row & { value: AlertsWeek }>();
	let fetchedAt: number | null = null;
	for (const r of rows) {
		if (r.value.kind !== "week") continue;
		const prev = byWeek.get(r.value.week);
		if (!prev || r.fetchedAt >= prev.fetchedAt) byWeek.set(r.value.week, r as Row & { value: AlertsWeek });
		fetchedAt = Math.max(fetchedAt ?? 0, r.fetchedAt);
	}
	const weeks = [...byWeek.values()].sort((a, b) => a.value.week.localeCompare(b.value.week)).slice(-WEEKS);
	const complete = weeks.filter((w) => w.value.ended).slice(-RECENT_WEEKS);
	const national = zero();
	const byState = new Map<string, [number, number, number][]>();
	const byMuni = new Map<
		string,
		{ acc: [number, number, number][]; m: AlertsWeek["municipalities"][string] }
	>();
	const byPa = new Map<string, { acc: [number, number, number][]; name: string; iucn: string | null }>();
	for (const w of complete) {
		addInto(national, w.value.venezuela);
		for (const [iso, s] of Object.entries(w.value.states)) {
			const acc = byState.get(iso) ?? zero();
			addInto(acc, s);
			byState.set(iso, acc);
		}
		for (const [id, m] of Object.entries(w.value.municipalities)) {
			const e = byMuni.get(id) ?? { acc: zero(), m };
			addInto(e.acc, m);
			byMuni.set(id, e);
		}
		for (const [id, p] of Object.entries(w.value.protectedAreas)) {
			const e = byPa.get(id) ?? { acc: zero(), name: p.name, iucn: p.iucn };
			addInto(e.acc, p);
			byPa.set(id, e);
		}
	}
	const officialNames = new Map(municipalities().map((m) => [m.code, m.name]));
	const byForest = <T extends ForestSplit>(a: T, b: T) => b.forest.total - a.forest.total;
	const newestVersion = weeks.at(-1)?.value.version ?? null;
	const budget = gfwAlerts.freshness.dataMs ?? 21 * DAY;
	const newestWeek = weeks.at(-1)?.observedAt ?? null;
	return {
		now,
		label: LABEL,
		method: METHOD,
		caveat: CAVEAT,
		placesNote: PLACES_NOTE,
		version: newestVersion,
		fetchedAt,
		stale: newestWeek === null || now - newestWeek > budget,
		weeks: weeks.map((w) => ({
			week: w.value.week,
			ended: w.value.ended,
			...split(w.value.venezuela),
		})),
		recent: {
			from: complete[0]?.value.week ?? "",
			to: complete.at(-1)?.value.week ?? "",
			weeks: complete.length,
		},
		venezuela: fromAcc(national),
		states: [...byState]
			.map(([iso, acc]) => ({ iso, name: stateByIso(iso)?.name ?? iso, ...fromAcc(acc) }))
			.sort((a, b) => byForest(a, b) || a.iso.localeCompare(b.iso)),
		municipalities: [...byMuni]
			.map(([gadmId, e]) => ({
				gadmId,
				name: (e.m.municipality ? officialNames.get(e.m.municipality) : null) ?? e.m.gadmName,
				code: e.m.municipality,
				state: e.m.state,
				stateName: stateByIso(e.m.state)?.name ?? e.m.state,
				...fromAcc(e.acc),
			}))
			.sort((a, b) => byForest(a, b) || a.gadmId.localeCompare(b.gadmId))
			.slice(0, 25),
		protectedAreas: mergeSameName(
			[...byPa].map(([wdpaId, e]) => ({ wdpaIds: [wdpaId], name: e.name, iucn: e.iucn, ...fromAcc(e.acc) })),
		)
			.sort((a, b) => byForest(a, b) || (a.wdpaIds[0] ?? "").localeCompare(b.wdpaIds[0] ?? ""))
			.slice(0, 25),
	};
}

type PaRow = ForestSplit & { wdpaIds: string[]; name: string; iucn: string | null };

/**
 * Protected areas WDPA lists more than once: the same name and figures within 5 % of each other (the same area under
 * two records) make one row with every id and the larger figure, never the sum. Same-named areas with different
 * figures stay apart.
 */
export function mergeSameName(rows: readonly PaRow[]): PaRow[] {
	const by = new Map<string, PaRow>();
	for (const r of rows) {
		const name = r.name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
		const same = [...by.entries()].find(
			([k, p]) =>
				k.startsWith(`${name}|`) &&
				Math.abs(p.forest.total - r.forest.total) <= 0.05 * Math.max(p.forest.total, r.forest.total),
		);
		const key = same?.[0] ?? `${name}|${r.wdpaIds[0] ?? ""}`;
		const prev = same?.[1];
		if (!prev) {
			by.set(key, { ...r, wdpaIds: [...r.wdpaIds] });
			continue;
		}
		const ids = [...new Set([...prev.wdpaIds, ...r.wdpaIds])].sort();
		by.set(key, r.forest.total > prev.forest.total ? { ...r, wdpaIds: ids } : { ...prev, wdpaIds: ids });
	}
	return [...by.values()];
}

export function forestView(store: Store, now: number): ForestView {
	const rows = store
		.latestPerSeries<GfwAlerts>(gfwAlerts.id, now - (WEEKS + 1) * 7 * DAY, 100)
		.filter((r) => r.series.startsWith("week:"));
	const view = forestViewOf(rows, now);
	return {
		...view,
		// Weeks that did not change are not stored again: the last good run says when GFW was last read.
		fetchedAt: store.lastSuccessAt(gfwAlerts.id) ?? view.fetchedAt,
		feed: gfwAlerts.id,
		attribution: gfwAlerts.licence.attribution,
		sourceUrl: GFW_HOME,
	};
}

export const forestPanel: Panel<ForestView> = {
	id: "forest",
	onDemand: true,
	sources: [gfwAlerts.id],
	compute: (store, now) => forestView(store, now),
};
