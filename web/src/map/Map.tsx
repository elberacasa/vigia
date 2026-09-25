import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { lang, t } from "../lib/i18n.ts";
import { reducedMotion } from "../lib/prefs.ts";
import { FRAME, NEIGHBOURS, STATES } from "./geometry.gen.ts";
import { project } from "./project.ts";
import { type Box, FULL, fitBox, MAX_ZOOM, zoomBox } from "./viewbox.ts";

/**
 * Venezuela by state, hand-built SVG (about 17 KB gzipped for the whole country; a tiled basemap would add ~250 KB and
 * a tile server). Selecting a state animates the viewBox to it, fades in its municipalities (loaded on demand) and dims
 * the rest. Zoom is +/− buttons only: wheel and pinch never hijack the page scroll.
 */

const SHORT: Record<string, string> = {
	"VE-A": "D. Capital",
	"VE-X": "La Guaira",
	"VE-W": "Dep. Federales",
	"VE-Y": "D. Amacuro",
};
/** Screen size of every state label, in CSS px: one size, a halo, collisions resolved by dropping the smaller state. */
const LABEL_PX = 11;
/** Below this map width (CSS px at full view) the small central states are not labelled at all. */
const SMALL_STATES_MIN_PX = 900;
const SMALL = new Set(["VE-M", "VE-D", "VE-G", "VE-U", "VE-O", "VE-A", "VE-X", "VE-H"]);
const ZOOM_MS = 450;

/**
 * Context labels (projected from lon/lat), drawn only where they fit: `room` is the width in degrees of longitude the
 * label may take without running onto Venezuela, and a label that would collide with a state label is dropped.
 * Venezuela's claim west of the Essequibo is marked as such, as on INE maps.
 */
const CONTEXT: readonly {
	es: string;
	en: string;
	lon: number;
	lat: number;
	room: number;
	sea?: boolean;
	anchor?: "start" | "end";
}[] = [
	{ es: "Colombia", en: "Colombia", lon: -71.3, lat: 4.4, room: 4 },
	{ es: "Brasil", en: "Brazil", lon: -64.2, lat: 1.25, room: 4 },
	{ es: "Mar Caribe", en: "Caribbean Sea", lon: -65.6, lat: 12.35, room: 5, sea: true },
	{ es: "Guyana", en: "Guyana", lon: -59.62, lat: 6.35, room: 1.7, anchor: "end" },
	{ es: "en reclamación", en: "under claim", lon: -59.62, lat: 6.08, room: 1.7, anchor: "end", sea: true },
	{ es: "Atlántico", en: "Atlantic", lon: -59.62, lat: 9.9, room: 1.1, anchor: "end", sea: true },
	{ es: "Trinidad y Tobago", en: "Trinidad and Tobago", lon: -60.9, lat: 11.55, room: 3 },
];

export interface StateFill {
	/** CSS class suffix: map-state--<tone>. */
	tone: "none" | "ok" | "drop" | "severe" | "nodata" | "signal";
	/** Screen-reader text for the state's current reading. */
	label?: string;
	/** 0..1 strength for graded tones (reports). */
	intensity?: number;
}

interface Muni {
	code: string;
	name: string;
	state: string;
	d: string;
}
let muniCache: readonly Muni[] | null = null;
/** Municipality outlines (≈45 KB gzipped) arrive only when someone zooms into a state. */
async function loadMunicipalities(): Promise<readonly Muni[]> {
	muniCache ??= (await import("./municipalities.gen.ts")).MUNICIPALITIES;
	return muniCache;
}

export function reduceMotion(): boolean {
	return reducedMotion.value || matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string, px: number, tracking = 0): number {
	measureCtx ??= document.createElement("canvas").getContext("2d");
	if (!measureCtx) return text.length * px * (0.58 + tracking);
	measureCtx.font = `600 ${px}px Archivo, system-ui, sans-serif`;
	return measureCtx.measureText(text).width + text.length * px * tracking;
}

const overlaps = (a: Box, b: Box) =>
	a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

export function VenezuelaMap(props: {
	fills?: Readonly<Record<string, StateFill>>;
	selected?: string | null;
	onSelect?: (iso: string | null) => void;
	/** Point layers drawn above the states. `k` is the zoom (1 at full view); marks divide by it to keep screen size. */
	layers?: (k: number) => ComponentChildren;
	/** Rasters drawn under the state borders (satellite, night lights); states become outlines. */
	underlay?: ComponentChildren;
	/** Overlay on the map's top edge (the "viewing the past" banner). */
	banner?: ComponentChildren;
	/** A past view: amber frame, no change flashes. */
	past?: boolean;
	/**
	 * Flash a state's outline once when its tone changes under the same key (live data only). Pass the layer as the key:
	 * a layer switch or a return from a replay changes the key, and is not a change in the data.
	 */
	flashKey?: string | null;
	/** Municipality code to outline in the selected state (e.g. from the search palette). */
	highlight?: string | null;
}) {
	const svgRef = useRef<SVGSVGElement>(null);
	const [box, setBox] = useState<Box>(FULL);
	const boxRef = useRef<Box>(FULL);
	const anim = useRef<number | null>(null);
	const [moving, setMoving] = useState(false);
	const [px, setPx] = useState(0);
	const [hover, setHover] = useState<{ name: string; detail: string } | null>(null);
	const [munis, setMunis] = useState<readonly Muni[]>([]);
	const [flashes, setFlashes] = useState<Record<string, number>>({});
	const prevTones = useRef<Map<string, string> | null>(null);
	const prevKey = useRef<string | null>(null);
	const areas = useRef<Map<string, number>>(new Map());
	const drag = useRef<{ x: number; y: number; box: Box; moved: boolean } | null>(null);
	const suppressClick = useRef(false);

	const k = box[2] / FRAME.width;
	const unitsPerPx = px > 0 ? box[2] / px : FRAME.width / 700;

	/** Applies a viewBox without re-rendering (per animation frame); CSS vars keep labels and marks at screen size. */
	const paint = (b: Box) => {
		const svg = svgRef.current;
		if (!svg) return;
		svg.setAttribute("viewBox", b.map((v) => v.toFixed(2)).join(" "));
		const width = svg.clientWidth || 700;
		svg.style.setProperty("--u", (b[2] / width).toFixed(4));
		svg.style.setProperty("--zk", (b[2] / FRAME.width).toFixed(4));
	};

	const animateTo = (target: Box) => {
		if (anim.current !== null) cancelAnimationFrame(anim.current);
		const from = boxRef.current;
		boxRef.current = target;
		if (reduceMotion() || from.every((v, i) => Math.abs(v - (target[i] as number)) < 0.5)) {
			paint(target);
			setBox(target);
			setMoving(false);
			return;
		}
		const start = performance.now();
		setMoving(true);
		const step = (now: number) => {
			const p = Math.min(1, (now - start) / ZOOM_MS);
			const e = easeInOut(p);
			paint(from.map((v, i) => v + ((target[i] as number) - v) * e) as unknown as Box);
			if (p < 1) anim.current = requestAnimationFrame(step);
			else {
				anim.current = null;
				setBox(target);
				setMoving(false);
			}
		};
		anim.current = requestAnimationFrame(step);
	};

	// Selecting a state zooms to it and loads its municipalities; clearing the selection returns to the country.
	useEffect(() => {
		const iso = props.selected;
		if (!iso) {
			setMunis([]);
			animateTo(FULL);
			return;
		}
		const path = svgRef.current?.querySelector<SVGPathElement>(`[data-iso="${iso}"]`);
		if (path) {
			const b = path.getBBox();
			animateTo(fitBox([b.x, b.y, b.width, b.height]));
		}
		let alive = true;
		const code = STATES.find((s) => s.iso === iso)?.code;
		void loadMunicipalities()
			.then((all) => {
				if (alive) setMunis(all.filter((m) => m.state === code));
			})
			.catch(() => {
				// Offline without the chunk cached: the state still zooms, without municipal lines.
			});
		return () => {
			alive = false;
		};
	}, [props.selected]);

	useEffect(
		() => () => {
			if (anim.current !== null) cancelAnimationFrame(anim.current);
		},
		[],
	);

	// Width in CSS px decides label density (small states only on a wide map) and keeps labels at 11 px on screen.
	useLayoutEffect(() => {
		const svg = svgRef.current;
		if (!svg) return;
		const measure = () => {
			setPx(svg.clientWidth);
			paint(boxRef.current);
		};
		measure();
		for (const s of STATES) {
			const b = svg.querySelector<SVGPathElement>(`[data-iso="${s.iso}"]`)?.getBBox();
			if (b) areas.current.set(s.iso, b.width * b.height);
		}
		const ro = new ResizeObserver(measure);
		ro.observe(svg);
		return () => ro.disconnect();
	}, []);

	// One outline flash per state whose tone changed with new live data (never on first paint, a layer switch or a
	// replay). Fills are rebuilt on every render, so tones are compared, not objects.
	useEffect(() => {
		const tones = new Map(STATES.map((s) => [s.iso, props.fills?.[s.iso]?.tone ?? "none"]));
		const prev = prevTones.current;
		const sameKey = prevKey.current === (props.flashKey ?? null);
		prevTones.current = tones;
		prevKey.current = props.flashKey ?? null;
		if (!prev || !sameKey || !props.flashKey || reduceMotion()) return;
		const changed = STATES.filter((s) => prev.get(s.iso) !== tones.get(s.iso)).map((s) => s.iso);
		if (!changed.length) return;
		const stampAt = Date.now();
		setFlashes((f) => ({ ...f, ...Object.fromEntries(changed.map((iso) => [iso, stampAt])) }));
		setTimeout(() => {
			setFlashes((f) => Object.fromEntries(Object.entries(f).filter(([, at]) => at !== stampAt)));
		}, 1_400);
	}, [props.fills]);

	/** Labels placed selected-first, then largest state first; one that would overlap a placed label is dropped. */
	const labels = useMemo(() => {
		const fullPx = px / k;
		const placed: Box[] = [];
		const states: { iso: string; x: number; y: number; text: string }[] = [];
		const inView = (b: Box) =>
			b[0] >= box[0] && b[1] >= box[1] && b[0] + b[2] <= box[0] + box[2] && b[1] + b[3] <= box[1] + box[3];
		const order = [...STATES].sort(
			(a, b) =>
				Number(b.iso === props.selected) - Number(a.iso === props.selected) ||
				(areas.current.get(b.iso) ?? 0) - (areas.current.get(a.iso) ?? 0),
		);
		for (const s of order) {
			const small = SMALL.has(s.iso) && fullPx < SMALL_STATES_MIN_PX && k > 0.6;
			if (small && s.iso !== props.selected) continue;
			const text = SHORT[s.iso] && k > 0.5 ? (SHORT[s.iso] as string) : s.name;
			const w = (textWidth(text, LABEL_PX) + 8) * unitsPerPx;
			const h = (LABEL_PX + 5) * unitsPerPx;
			const [x, y] = s.label;
			const b: Box = [x - w / 2, y - h / 2, w, h];
			if (!inView(b) || placed.some((p) => overlaps(p, b))) continue;
			placed.push(b);
			states.push({ iso: s.iso, x, y, text });
		}
		const context: { key: string; x: number; y: number; text: string; sea: boolean; anchor: string }[] = [];
		for (const c of CONTEXT) {
			const text = t(c.es, c.en);
			const w = textWidth(text.toUpperCase(), 10, 0.16) * unitsPerPx;
			if (w > c.room * FRAME.cos * FRAME.k) continue;
			const h = 14 * unitsPerPx;
			const [x, y] = project(c.lon, c.lat);
			const left = c.anchor === "end" ? x - w : c.anchor === "start" ? x : x - w / 2;
			const b: Box = [left, y - h / 2, w, h];
			if (!inView(b) || placed.some((p) => overlaps(p, b))) continue;
			placed.push(b);
			context.push({ key: c.es, x, y, text, sea: Boolean(c.sea), anchor: c.anchor ?? "middle" });
		}
		return { states, context };
	}, [px, box, props.selected, k, unitsPerPx, lang.value]);

	/** A real 2° graticule (lines of longitude and latitude), not a decorative grid. */
	const graticule = useMemo(() => {
		const parts: string[] = [];
		for (let lon = -72; lon <= -60; lon += 2) {
			const [x] = project(lon, 0);
			parts.push(`M${x.toFixed(1)} 0V${FRAME.height}`);
		}
		for (let lat = 2; lat <= 12; lat += 2) {
			const [, y] = project(-70, lat);
			parts.push(`M0 ${y.toFixed(1)}H${FRAME.width}`);
		}
		return parts.join("");
	}, []);

	const zoomed = box[2] < FRAME.width - 1;
	const select = (iso: string | null) => props.onSelect?.(iso);
	const zoomBy = (factor: number) => animateTo(zoomBox(boxRef.current, factor));
	const stateName = (code: string) => STATES.find((s) => s.code === code)?.name ?? "";

	return (
		<figure
			class={`map${moving ? " is-moving" : ""}${props.selected ? " has-selection" : ""}${props.past ? " is-past" : ""}${zoomed ? " is-zoomed" : ""}`}
			aria-label={t("Mapa de Venezuela por estados", "Map of Venezuela by state")}
			onKeyDown={(e) => {
				if (e.key === "Escape" && (props.selected || zoomed)) {
					e.stopPropagation();
					if (props.selected) select(null);
					else animateTo(FULL);
				}
			}}
		>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: the sea click is a shortcut; Esc on the figure does the same. */}
			<svg
				ref={svgRef}
				class="map__svg"
				viewBox={box.join(" ")}
				onPointerDown={(e) => {
					// Mouse drag pans a zoomed map; touch keeps scrolling the page.
					if (e.pointerType !== "mouse" || e.button !== 0 || !zoomed) return;
					drag.current = { x: e.clientX, y: e.clientY, box: boxRef.current, moved: false };
				}}
				onPointerMove={(e) => {
					const d = drag.current;
					const svg = svgRef.current;
					if (!d || !svg) return;
					if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
					if (!d.moved) svg.setPointerCapture(e.pointerId);
					d.moved = true;
					const scale = d.box[2] / svg.clientWidth;
					const next: Box = [
						Math.min(Math.max(0, d.box[0] - (e.clientX - d.x) * scale), FRAME.width - d.box[2]),
						Math.min(Math.max(0, d.box[1] - (e.clientY - d.y) * scale), FRAME.height - d.box[3]),
						d.box[2],
						d.box[3],
					];
					boxRef.current = next;
					paint(next);
				}}
				onPointerUp={() => {
					const d = drag.current;
					drag.current = null;
					if (d?.moved) {
						suppressClick.current = true;
						setBox(boxRef.current);
					}
				}}
				onClickCapture={(e) => {
					if (suppressClick.current) {
						suppressClick.current = false;
						e.stopPropagation();
					}
				}}
				onClick={(e) => {
					// A click on the sea is a mouse shortcut back to the country; Esc and "← Venezuela" do the same.
					if (props.selected && (e.target as Element).classList.contains("map__sea")) select(null);
				}}
			>
				<title>{t("Mapa de Venezuela por estados", "Map of Venezuela by state")}</title>
				<defs>
					{/* "No data" is hatched land, never a lighter fill that could read as water or as normal. */}
					<pattern
						id="map-hatch"
						width="9"
						height="9"
						patternUnits="userSpaceOnUse"
						patternTransform="rotate(45)"
					>
						<rect width="9" height="9" class="map-hatch__bg" />
						<line x1="0" y1="0" x2="0" y2="9" class="map-hatch__line" />
					</pattern>
				</defs>
				<rect
					x={-FRAME.width}
					y={-FRAME.height}
					width={FRAME.width * 3}
					height={FRAME.height * 3}
					class="map__sea"
				/>
				<path d={graticule} class="map__graticule" />
				{/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: decorative context shapes, nothing focusable inside. */}
				<g class="map__neighbours" aria-hidden="true">
					{NEIGHBOURS.map((n) => (
						<path key={n.name} d={n.d} class={n.kind === "disputed" ? "map__disputed" : "map__neighbour"} />
					))}
				</g>
				{props.underlay ? <g class="map__underlay">{props.underlay}</g> : null}
				<g class={`map__states${props.underlay ? " map__states--outline" : ""}`}>
					{STATES.map((s) => {
						const fill = props.fills?.[s.iso];
						const selected = props.selected === s.iso;
						return (
							// biome-ignore lint/a11y/useSemanticElements: an SVG path cannot be a <button>; it gets button semantics and keys.
							<path
								key={s.iso}
								d={s.d}
								data-iso={s.iso}
								class={`map-state map-state--${fill?.tone ?? "none"}${selected ? " is-selected" : ""}`}
								style={fill?.intensity !== undefined ? { "--k": fill.intensity.toFixed(3) } : undefined}
								role="button"
								// Lowercase: Preact sets SVG attributes verbatim, and an SVG "tabIndex" attribute does nothing.
								tabindex={0}
								aria-label={`${s.name}${fill?.label ? `: ${fill.label}` : ""}`}
								aria-pressed={selected}
								onClick={() => select(selected ? null : s.iso)}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										select(selected ? null : s.iso);
									}
								}}
								onPointerEnter={() => setHover({ name: s.name, detail: fill?.label ?? "" })}
								onPointerLeave={() => setHover((h) => (h?.name === s.name ? null : h))}
							/>
						);
					})}
				</g>
				{munis.length ? (
					// biome-ignore lint/a11y/noAriaHiddenOnFocusable: outlines only; the state stays the focusable target.
					<g class="map__munis" key={props.selected ?? ""} aria-hidden="true">
						{munis.map((m) => (
							<path
								key={m.code}
								d={m.d}
								class={`map-muni${m.code === props.highlight ? " is-highlighted" : ""}`}
								onPointerEnter={() =>
									setHover({
										name: m.name,
										detail: t(`municipio, ${stateName(m.state)}`, `municipality, ${stateName(m.state)}`),
									})
								}
								onPointerLeave={() => setHover((h) => (h?.name === m.name ? null : h))}
							/>
						))}
					</g>
				) : null}
				{(() => {
					const m = props.highlight ? munis.find((x) => x.code === props.highlight) : undefined;
					return m ? <path key={`hl-${m.code}`} d={m.d} class="map-muni-highlight" /> : null;
				})()}
				{/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: a flash repeats a change already in the fills. */}
				<g class="map__flashes" aria-hidden="true">
					{Object.entries(flashes).map(([iso, at]) => {
						const s = STATES.find((x) => x.iso === iso);
						return s ? <path key={`${iso}-${at}`} d={s.d} class="map-flash" /> : null;
					})}
				</g>
				<g class="map__layers">{props.layers?.(k)}</g>
				{/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: geographic context, not data. */}
				<g class="map__context" aria-hidden="true">
					{labels.context.map((c) => (
						<text
							key={c.key}
							x={c.x}
							y={c.y}
							class={`map__context-label${c.sea ? " map__context-label--sea" : ""}`}
							text-anchor={c.anchor}
						>
							{c.text}
						</text>
					))}
				</g>
				{/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: labels duplicate each state's accessible name. */}
				<g class="map__labels" aria-hidden="true">
					{labels.states.map((l) => (
						<text
							key={l.iso}
							x={l.x}
							y={l.y}
							class={`map__label${l.iso === props.selected ? " is-selected" : ""}`}
						>
							{l.text}
						</text>
					))}
				</g>
			</svg>
			{props.banner ? <div class="map__banner">{props.banner}</div> : null}
			{props.selected || zoomed ? (
				<button
					type="button"
					class="map__back"
					onClick={() => (props.selected ? select(null) : animateTo(FULL))}
				>
					<span aria-hidden="true">←</span> Venezuela
				</button>
			) : null}
			<fieldset class="map__zoom">
				<legend class="sr-only">{t("Zoom del mapa", "Map zoom")}</legend>
				<button
					type="button"
					onClick={() => zoomBy(1 / 1.6)}
					disabled={box[2] <= FRAME.width / MAX_ZOOM + 1}
					aria-label={t("Acercar", "Zoom in")}
				>
					+
				</button>
				<button
					type="button"
					onClick={() => zoomBy(1.6)}
					disabled={!zoomed}
					aria-label={t("Alejar", "Zoom out")}
				>
					−
				</button>
			</fieldset>
			{(() => {
				// The hovered place, or else the municipality picked in the palette (it stays named until cleared).
				const picked = props.highlight ? munis.find((m) => m.code === props.highlight) : undefined;
				const shown =
					hover ??
					(picked
						? {
								name: picked.name,
								detail: t(
									`municipio, ${stateName(picked.state)}`,
									`municipality, ${stateName(picked.state)}`,
								),
							}
						: null);
				return shown ? (
					<p class={`map__hover${picked && !hover ? " is-pinned" : ""}`} aria-live="polite">
						<strong>{shown.name}</strong>
						{shown.detail ? <span> · {shown.detail}</span> : null}
					</p>
				) : null;
			})()}
		</figure>
	);
}
