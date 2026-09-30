import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { INFRA_WORD } from "../lib/entity-words.ts";
import { lang, t } from "../lib/i18n.ts";
import { type Facility, type GridLine, loadCore, loadHealth } from "./facilities.ts";
import {
	FACILITY_GROUPS,
	type FacilityGroup,
	facilitiesShown,
	facilityGroups,
	toggleFacilityGroup,
} from "./view.ts";

/**
 * "Instalaciones": the ontology's facilities as small neutral marks, one shape per group (never colour alone), and
 * the 230/400/765 kV transmission grid as thin lines under them. A press on a mark selects the facility (inspector,
 * page); the selected one is ringed in the accent and named. Static: nothing moves. Its own chunk, with its data
 * (≈ 21 KB gzip, health centres another ≈ 19 KB only when shown).
 */

/** Shapes in map units at full view (they keep their screen size while zooming, like the quakes). */
function Shape({ group }: { group: FacilityGroup }) {
	switch (group) {
		case "energia":
			return <rect x={-3.6} y={-3.6} width={7.2} height={7.2} class="facility" />;
		case "petroleo":
			return <path d="M0-4.4 3.8-2.2v4.4L0 4.4-3.8 2.2v-4.4Z" class="facility" />;
		case "transporte":
			// A capsule: never a circle, which is the quakes' shape.
			return <rect x={-4.6} y={-2.6} width={9.2} height={5.2} rx={2.6} class="facility" />;
		case "agua":
			return <path d="M-4.2-3H4.2L0 4.2Z" class="facility" />;
		case "salud":
			return <path d="M-1.3-4.2h2.6v2.9h2.9v2.6H1.3v2.9h-2.6V1.3h-2.9v-2.6h2.9Z" class="facility" />;
	}
}

export const GROUP_WORD: Record<FacilityGroup, { es: string; en: string }> = {
	energia: { es: "Electricidad", en: "Power" },
	petroleo: { es: "Petróleo y gas", en: "Oil and gas" },
	transporte: { es: "Puertos y aeropuertos", en: "Ports and airports" },
	agua: { es: "Represas y embalses", en: "Dams and reservoirs" },
	salud: { es: "Salud", en: "Health" },
};

type Loaded = { facilities: Facility[]; grid: readonly GridLine[] };

/** The facilities of the chosen groups (health loads only when asked for). */
export function useFacilities(groups: ReadonlySet<FacilityGroup>): Loaded | null {
	const [core, setCore] = useState<Loaded | null>(null);
	const [health, setHealth] = useState<Facility[] | null>(null);
	const wantHealth = groups.has("salud");
	useEffect(() => {
		let alive = true;
		loadCore()
			.then((c) => alive && setCore(c))
			.catch(() => {
				// Offline before the chunk was cached: the layer stays empty; its row says nothing is drawn.
			});
		return () => {
			alive = false;
		};
	}, []);
	useEffect(() => {
		if (!wantHealth || health) return;
		let alive = true;
		loadHealth()
			.then((h) => alive && setHealth(h))
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [wantHealth]);
	// The same arrays while nothing changes, so the marks are not rebuilt when the map re-renders (every second).
	return useMemo(
		() =>
			core
				? {
						facilities: [...core.facilities, ...(wantHealth && health ? health : [])].filter((f) =>
							groups.has(f.group),
						),
						grid: groups.has("energia") ? core.grid : [],
					}
				: null,
		[core, health, groups, wantHealth],
	);
}

export function FacilityMarks({
	facilities,
	grid,
	selected,
	onSelect,
}: {
	facilities: readonly Facility[];
	grid: readonly GridLine[];
	selected: string | null;
	onSelect?: ((f: Facility) => void) | undefined;
}) {
	const l = lang.value;
	const picked = selected ? facilities.find((f) => f.id === selected) : undefined;
	return (
		<g class="layer-facilities">
			{grid.map((g) => (
				<path key={g.id} d={g.d} class={`grid-line grid-line--${g.kv}`}>
					<title>{t(`Línea de ${g.kv} kV (trazado de OSM)`, `${g.kv} kV line (OSM mapping)`)}</title>
				</path>
			))}
			{facilities.map((f) => {
				const { x, y } = f;
				return (
					// biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut; every facility is reachable by keyboard through the search (/) and the entity pages.
					<g
						key={f.id}
						class={`facility-mark facility-mark--${f.group}${f.id === selected ? " is-selected" : ""}`}
						style={{ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(var(--zk, 1))` }}
						onClick={
							onSelect
								? (e) => {
										e.stopPropagation();
										onSelect(f);
									}
								: undefined
						}
					>
						<title>{`${f.name} · ${INFRA_WORD[f.kind]?.[l] ?? f.kind}`}</title>
						<circle r={9} class="facility-hit" />
						<Shape group={f.group} />
					</g>
				);
			})}
			{picked
				? (() => {
						const { x, y } = picked;
						return (
							// biome-ignore lint/a11y/noAriaHiddenOnFocusable: the ring and name repeat the selection the inspector states.
							<g class="facility-pick" aria-hidden="true">
								<g
									style={{ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(var(--zk, 1))` }}
								>
									<circle r={10} class="facility-ring" />
								</g>
								<text x={x} y={y} class="map__label facility-label">
									{picked.name}
								</text>
							</g>
						);
					})()
				: null}
		</g>
	);
}

/**
 * The layer on the room's map: the chosen groups, selection and a press that selects. With `only`, just the
 * selected facility (picked in the search or a list while the layer is off), so the selection is always on the map.
 */
export function FacilityLayer({
	selected,
	onSelect,
	only = false,
}: {
	selected: string | null;
	onSelect: (f: Facility) => void;
	only?: boolean;
}) {
	const data = useFacilities(only ? ALL_GROUPS : facilityGroups.value);
	const n = data && !only ? data.facilities.length : null;
	useEffect(() => {
		if (!only) facilitiesShown.value = n;
	}, [n, only]);
	useEffect(
		() => () => {
			if (!only) facilitiesShown.value = null;
		},
		[only],
	);
	const facilities = useMemo(
		() => (data && only ? data.facilities.filter((f) => f.id === selected) : (data?.facilities ?? NONE)),
		[data, only, selected],
	);
	// A stable handler, so the memoized marks are not redrawn because the caller passed a new arrow.
	const handler = useRef(onSelect);
	handler.current = onSelect;
	const select = useMemo(() => (f: Facility) => handler.current(f), []);
	const grid = data && !only ? data.grid : NONE_GRID;
	// The same vnode while nothing changed: Preact skips the 1,325 marks when the map re-renders every second.
	const marks = useMemo(
		() => <FacilityMarks facilities={facilities} grid={grid} selected={selected} onSelect={select} />,
		[facilities, grid, selected, select],
	);
	return data ? marks : null;
}

const NONE: readonly Facility[] = [];
const NONE_GRID: readonly GridLine[] = [];

const ALL_GROUPS: ReadonlySet<FacilityGroup> = new Set(FACILITY_GROUPS);

/** The key under the layer list while the layer is on: each group's shape, and a switch per group. */
export function FacilityLegend() {
	const on = facilityGroups.value;
	return (
		<fieldset class="layers__facilities">
			<legend class="sr-only">{t("Grupos de instalaciones", "Facility groups")}</legend>
			{FACILITY_GROUPS.map((g) => (
				<label key={g} class={`facility-key${on.has(g) ? " is-on" : ""}`}>
					<input type="checkbox" checked={on.has(g)} onChange={() => toggleFacilityGroup(g)} />
					<svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true" class={`facility-mark--${g}`}>
						<Shape group={g} />
					</svg>
					{t(GROUP_WORD[g].es, GROUP_WORD[g].en)}
				</label>
			))}
			<p class="note">
				{t(
					"OpenStreetMap (ODbL), OurAirports, IMF PortWatch. Toca una para ver su ficha.",
					"OpenStreetMap (ODbL), OurAirports, IMF PortWatch. Tap one for its page.",
				)}
			</p>
		</fieldset>
	);
}
