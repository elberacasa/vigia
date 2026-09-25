import { int } from "../../lib/format.ts";
import { lang, t } from "../../lib/i18n.ts";
import { STATES } from "../../map/geometry.gen.ts";
import { pathBox } from "../../map/project.ts";
import { countryLabel, regionLabel } from "./labels.ts";
import { type Bucket, type Group, type Row, type Summary, sunflower } from "./model.ts";

const DOT = 12;
const SPACING = 29;

/** The mainland's own box (the frame also holds neighbours' margins), with a little air. */
const VIEW = (() => {
	let [x0, y0, x1, y1] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 0, 0];
	for (const s of STATES) {
		const [x, y, w, h] = pathBox(s.d);
		x0 = Math.min(x0, x);
		y0 = Math.min(y0, y);
		x1 = Math.max(x1, x + w);
		y1 = Math.max(y1, y + h);
	}
	const pad = 30;
	return `${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`;
})();

/**
 * Where the sources are. Regional feeds (a Venezuelan state's own outlets and feeds) are dots on their state, one per
 * feed, coloured by health; national, diaspora and international feeds are counted beside the map, and publishers
 * abroad get a strip by country. States and counters filter the catalogue.
 */
export function AtlasMap({
	summary,
	rows,
	bucketById,
	region,
	country,
	onRegion,
	onCountry,
}: {
	summary: Summary;
	rows: readonly Row[];
	bucketById: ReadonlyMap<string, Bucket>;
	region: string | null;
	country: string | null;
	onRegion: (r: string) => void;
	onCountry: (c: string) => void;
}) {
	const l = lang.value;
	const byState = new Map<string, Row[]>();
	for (const r of rows) {
		if (r.region.startsWith("VE-")) byState.set(r.region, [...(byState.get(r.region) ?? []), r]);
	}
	const withFeeds = summary.states.length;
	const classes: { key: string; n: number; sub: string }[] = [
		{
			key: "VE",
			n: summary.regions.VE,
			sub: t("medios y datos de alcance nacional", "national outlets and data"),
		},
		{
			key: "state",
			n: summary.regions.state,
			sub: t(`en ${withFeeds} de 24 estados`, `in ${withFeeds} of 24 states`),
		},
		{
			key: "diaspora",
			n: summary.regions.diaspora,
			sub: t("hechos fuera, sobre Venezuela", "made abroad, about Venezuela"),
		},
		{
			key: "intl",
			n: summary.regions.intl,
			sub: t(
				`${summary.countries.length} países u organismos`,
				`${summary.countries.length} countries or bodies`,
			),
		},
	];
	return (
		<div class="amap">
			<div class="amap__map">
				<svg viewBox={VIEW} class="amap__svg">
					<title>{t("Fuentes regionales por estado", "Regional sources by state")}</title>
					{STATES.map((s) => {
						const feeds = byState.get(s.iso) ?? [];
						const cls = `amap__state${feeds.length ? " has-feeds" : ""}${region === s.iso ? " is-on" : ""}`;
						if (!feeds.length) return <path key={s.iso} d={s.d} class={cls} />;
						const label = t(
							`${s.name}: ${feeds.length} fuentes regionales${region === s.iso ? " (filtro activo)" : ""}`,
							`${s.name}: ${feeds.length} regional sources${region === s.iso ? " (active filter)" : ""}`,
						);
						// A link, so the state is focusable and works without JS; the click filters in place.
						return (
							<a
								key={s.iso}
								href={`/fuentes?region=${s.iso}`}
								aria-label={label}
								onClick={(e) => {
									e.preventDefault();
									onRegion(s.iso);
								}}
							>
								<path d={s.d} class={cls} />
							</a>
						);
					})}
					{STATES.map((s) => {
						const feeds = byState.get(s.iso);
						if (!feeds) return null;
						const pts = sunflower(feeds.length, SPACING);
						const [cx, cy] = s.label;
						const top = Math.min(...pts.map((p) => p[1]));
						return (
							<g key={s.iso} class="amap__cluster" transform={`translate(${cx} ${cy})`}>
								{pts.map(([x, y], i) => {
									const f = feeds[i];
									return f ? (
										<circle
											key={f.id}
											cx={x}
											cy={y}
											r={DOT}
											class={`amap__dot amap__dot--${bucketById.get(f.id) ?? "pending"}`}
										/>
									) : null;
								})}
								{feeds.length > 1 ? (
									<text class="amap__count" x={0} y={top - DOT - 10} text-anchor="middle">
										{feeds.length}
									</text>
								) : null}
							</g>
						);
					})}
				</svg>
			</div>
			<div class="amap__side">
				<ul class="amap__classes">
					{classes.map((c) => (
						<li key={c.key}>
							<button
								type="button"
								class="amap__class"
								aria-pressed={region === c.key}
								onClick={() => onRegion(c.key)}
								disabled={c.n === 0}
							>
								<span class="amap__class-n">{int(c.n, l)}</span>
								<span class="amap__class-name">{regionLabel(c.key, l)}</span>
								<span class="amap__class-sub note">{c.sub}</span>
							</button>
						</li>
					))}
				</ul>
				{summary.countries.length > 0 ? (
					<div class="amap__world">
						<p class="caps amap__world-title">
							{t("Publicadores fuera de Venezuela", "Publishers outside Venezuela")}
						</p>
						<ul class="world">
							{summary.countries.map((g) => (
								<CountryChip key={g.key} g={g} on={country === g.key} onPick={onCountry} />
							))}
						</ul>
					</div>
				) : null}
			</div>
		</div>
	);
}

function CountryChip({ g, on, onPick }: { g: Group; on: boolean; onPick: (c: string) => void }) {
	const l = lang.value;
	const name = countryLabel(g.key, l);
	return (
		<li>
			<button
				type="button"
				class="world__chip"
				aria-pressed={on}
				onClick={() => onPick(g.key)}
				aria-label={t(`${name}: ${g.feeds} fuentes`, `${name}: ${g.feeds} sources`)}
			>
				<span class="world__code mono">{g.key === "INT" ? "—" : g.key}</span>
				<span class="world__name">{name}</span>
				<span class="world__n mono">{int(g.feeds, l)}</span>
			</button>
		</li>
	);
}
