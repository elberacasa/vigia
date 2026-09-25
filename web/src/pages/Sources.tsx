import { useMemo } from "preact/hooks";
import { health, meta, now } from "../lib/data.ts";
import { int } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { link } from "../lib/router.ts";
import "../ui/atlas/style.ts";
import { addStyles } from "../lib/css.ts";
import pagesCss from "../styles/pages.css?inline";
import panelsCss from "../styles/panels.css?inline";
import { AtlasMap } from "../ui/atlas/AtlasMap.tsx";
import { Catalogue } from "../ui/atlas/Catalogue.tsx";
import { CategoryGrid } from "../ui/atlas/CategoryGrid.tsx";
import { FeedSheet } from "../ui/atlas/FeedSheet.tsx";
import { Growth } from "../ui/atlas/Growth.tsx";
import { HealthBar } from "../ui/atlas/HealthBar.tsx";
import { categoryLabel, regionLabel } from "../ui/atlas/labels.ts";
import { type Bucket, bucketOf, growth, summarize, toRows } from "../ui/atlas/model.ts";
import { filters, openFeed, toggleFilter } from "../ui/atlas/state.ts";

addStyles(panelsCss);
addStyles(pagesCss);

/**
 * The sources atlas: every feed Vigía reads, how healthy it is right now, where it comes from and what it feeds.
 * Everything is read from /api/meta and /api/health, so a feed added on the server appears here with no client change.
 */
export function SourcesPage() {
	const l = lang.value;
	const rows = useMemo(
		() =>
			toRows(meta.value, (m) =>
				[
					...(m.category ?? []).flatMap((c) => [categoryLabel(c, "es"), categoryLabel(c, "en")]),
					m.region ? `${regionLabel(m.region, "es")} ${regionLabel(m.region, "en")}` : "",
				].join(" "),
			),
		[meta.value],
	);
	const bucketById = useMemo(
		() => new Map<string, Bucket>(health.value.map((h) => [h.id, bucketOf(h.state)])),
		[health.value],
	);
	const summary = useMemo(() => summarize(rows, bucketById), [rows, bucketById]);
	// Growth ends at "now" rounded to the minute, so the chart does not redraw every second.
	const minute = Math.floor(now.value / 60_000) * 60_000;
	const points = useMemo(() => growth(rows, minute), [rows, minute]);
	const f = filters.value;
	const open = openFeed.value ? rows.find((r) => r.id === openFeed.value) : undefined;
	const loading = rows.length === 0;
	const news = summary.categories.find((c) => c.key === "news")?.feeds ?? 0;

	const scrollToList = () =>
		requestAnimationFrame(() => document.getElementById("cat-title")?.scrollIntoView({ behavior: "smooth" }));

	return (
		<main class="page atlas">
			<header class="atlas__head">
				<p class="caps page__kicker">{t("Fuentes · atlas", "Sources · atlas")}</p>
				<h1 class="page__title">{t("De dónde sale cada cifra", "Where every figure comes from")}</h1>
				<p class="page__lede">
					{t(
						"Vigía solo muestra datos públicos, con su fuente y su hora. Cada fuente es una consulta verificada, vigilada por separado; ninguna cifra la inventa un modelo de IA.",
						"Vigía only shows public data, with its source and time. Each source is a verified feed, monitored on its own; no figure is made up by an AI model.",
					)}
				</p>
			</header>

			<section class="atlas__hero" aria-label={t("Resumen de fuentes", "Sources summary")}>
				<div class="atlas__count">
					<p class="atlas__big">{loading ? "—" : int(summary.feeds, l)}</p>
					<p class="atlas__big-label">{t("fuentes verificadas", "verified sources")}</p>
					<p class="atlas__big-sub note">
						{t(
							`de ${int(summary.publishers, l)} publicadores distintos · ${summary.categories.length} categorías`,
							`from ${int(summary.publishers, l)} distinct publishers · ${summary.categories.length} categories`,
						)}
					</p>
					<dl class="atlas__mini">
						<div>
							<dt>{t("Datos y mediciones", "Data and measurements")}</dt>
							<dd class="mono">{int(summary.feeds - news, l)}</dd>
						</div>
						<div>
							<dt>{t("Medios", "Outlets")}</dt>
							<dd class="mono">{int(news, l)}</dd>
						</div>
						<div>
							<dt>{t("Sin clave", "No key needed")}</dt>
							<dd class="mono">{int(summary.feeds - summary.needsKey, l)}</dd>
						</div>
					</dl>
				</div>
				<div class="atlas__health">
					<p class="caps atlas__label">{t("Estado ahora", "Health now")}</p>
					<HealthBar
						counts={summary.buckets}
						active={f.bucket}
						onPick={(b) => {
							toggleFilter("bucket", b);
							scrollToList();
						}}
					/>
					<a class="link atlas__status-link" {...link("status")}>
						{t("Detalle técnico en Estado", "Technical detail in Status")} →
					</a>
				</div>
				<div class="atlas__growth">
					<Growth points={points} undated={summary.undated} />
				</div>
			</section>

			<section class="atlas__section" aria-labelledby="atlas-cats">
				<h2 id="atlas-cats" class="atlas__h2">
					{t("Por categoría", "By category")}
				</h2>
				<CategoryGrid
					groups={summary.categories}
					total={summary.feeds}
					active={f.category}
					onPick={(c) => {
						toggleFilter("category", c);
						scrollToList();
					}}
				/>
			</section>

			<section class="atlas__section" aria-labelledby="atlas-map">
				<h2 id="atlas-map" class="atlas__h2">
					{t("Por lugar", "By place")}
				</h2>
				<AtlasMap
					summary={summary}
					rows={rows}
					bucketById={bucketById}
					region={f.region}
					country={f.country}
					onRegion={(r) => {
						toggleFilter("region", r);
						scrollToList();
					}}
					onCountry={(c) => {
						toggleFilter("country", c);
						scrollToList();
					}}
				/>
			</section>

			<Catalogue rows={rows} bucketById={bucketById} />

			<section class="atlas__section atlas__base" aria-labelledby="atlas-base">
				<h2 id="atlas-base" class="atlas__h2">
					{t("Datos de base", "Base data")}
				</h2>
				<p class="note">
					{t(
						"Capas fijas que no se consultan en vivo; no cuentan como fuentes arriba.",
						"Fixed layers that are not polled live; not counted as sources above.",
					)}
				</p>
				<ul class="atlas__base-list">
					<li>
						<strong>{t("Límites administrativos", "Administrative boundaries")}</strong>
						<span class="note">INE Venezuela vía OCHA / HDX · CC BY-IGO 3.0</span>
					</li>
					<li>
						<strong>{t("Nombres de lugares", "Place names")}</strong>
						<span class="note">GeoNames · CC BY 4.0</span>
					</li>
					<li>
						<strong>{t("Países vecinos y zona en disputa", "Neighbours and disputed zone")}</strong>
						<span class="note">
							Natural Earth · {t("dominio público", "public domain")}.{" "}
							{t(
								"El territorio Esequibo se dibuja como zona en disputa (administrada por Guyana, reclamada por Venezuela), sin línea propia.",
								"The Essequibo territory is drawn as a disputed zone (administered by Guyana, claimed by Venezuela), with no line of our own.",
							)}
						</span>
					</li>
					<li>
						<strong>{t("Tipografías", "Typefaces")}</strong>
						<span class="note">Archivo, Chivo Mono (Omnibus-Type) · SIL Open Font License 1.1</span>
					</li>
				</ul>
			</section>
			{open ? <FeedSheet row={open} /> : null}
		</main>
	);
}
