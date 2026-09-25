import { project } from "./project.ts";

export interface QuakePoint {
	id: string;
	lat: number;
	lon: number;
	mag: number;
	at: number;
}

const HOUR = 3_600_000;
const MONTH = 30 * 24 * HOUR;

/** Radius in map units at full view: area grows with magnitude, capped. */
export function quakeRadius(mag: number): number {
	return Math.min(40, 6 + Math.max(0, mag - 2.5) * 6);
}

/**
 * Outline opacity by age, so age reads without motion: 1 under an hour old, falling on a log scale to 0.35 at 30 days.
 */
export function quakeOpacity(ageMs: number): number {
	if (ageMs <= HOUR) return 1;
	const f = Math.min(1, Math.log(ageMs / HOUR) / Math.log(MONTH / HOUR));
	return Math.round((1 - 0.65 * f) * 100) / 100;
}

/**
 * Quakes that arrived while the page was open (by id). The first batch after load seeds the set without rings, so a
 * reload never "announces" old events; only a genuinely new id rings, once. Call with the full, unfiltered list (a
 * replay hides newer quakes; returning to live must not ring them).
 */
const seen = new Set<string>();
const arrivedAt = new Map<string, number>();
let seeded = false;

export function markArrivals(items: readonly QuakePoint[], now: number): void {
	if (!seeded) {
		if (!items.length) return;
		for (const q of items) seen.add(q.id);
		seeded = true;
		return;
	}
	for (const q of items) {
		if (seen.has(q.id)) continue;
		seen.add(q.id);
		arrivedAt.set(q.id, now);
	}
}

/** True for 2.5 s after a quake id first arrived while the page was open (its rings are then on screen). */
export function isRinging(id: string, now: number): boolean {
	const at = arrivedAt.get(id);
	return at !== undefined && now - at < 2_500;
}

/**
 * Circles sized by magnitude. A new quake rings once (two rings, 1.6 s), then stays a static circle whose outline fades
 * with age. Marks keep their screen size when the map zooms.
 */
export function QuakeLayer({ items, now }: { items: readonly QuakePoint[]; now: number }) {
	return (
		<g class="layer-quakes">
			{items.map((q) => {
				const [x, y] = project(q.lon, q.lat);
				const r = quakeRadius(q.mag);
				const ringing = isRinging(q.id, now);
				return (
					// Scaled by --zk (set per animation frame by the map) so a mark keeps its screen size while zooming.
					<g
						key={q.id}
						class="quake-mark"
						style={{ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(var(--zk, 1))` }}
					>
						<circle r={r} class="quake" style={{ "--o": quakeOpacity(now - q.at) }} />
						{ringing ? (
							<>
								<circle r={r} class="quake__ring" />
								<circle r={r} class="quake__ring quake__ring--late" />
							</>
						) : null}
					</g>
				);
			})}
		</g>
	);
}

/** Legend: circles for M3, M4 and M5 at the map's scale (`unit` = CSS px per map unit at full view). */
export function QuakeLegend({ unit }: { unit: number }) {
	const mags = [3, 4, 5];
	const rs = mags.map((m) => Math.max(2.5, quakeRadius(m) * unit));
	const h = Math.ceil(2 * Math.max(...rs) + 4);
	const cells = rs.map((r) => 2 * r + 30);
	const cx = (i: number) => cells.slice(0, i).reduce((a, w) => a + w, 2) + (rs[i] as number);
	return (
		<svg
			class="quake-legend"
			height={h}
			width={cells.reduce((a, w) => a + w, 2)}
			aria-label="M3, M4, M5"
			role="img"
		>
			{rs.map((r, i) => (
				<g key={mags[i]}>
					<circle cx={cx(i)} cy={h / 2} r={r} class="quake" style={{ "--o": 1 }} />
					<text x={cx(i) + r + 4} y={h / 2} class="quake-legend__text">
						M{mags[i]}
					</text>
				</g>
			))}
		</svg>
	);
}
