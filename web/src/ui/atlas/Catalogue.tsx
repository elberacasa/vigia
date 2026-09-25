import { useEffect, useMemo, useState } from "preact/hooks";
import { type FeedHealth, healthById, now } from "../../lib/data.ts";
import { ago, int } from "../../lib/format.ts";
import { lang, t } from "../../lib/i18n.ts";
import { href } from "../../lib/router.ts";
import {
	bucketLabel,
	categoryLabel,
	countryLabel,
	kindLabel,
	langLabel,
	panelLabel,
	regionLabel,
} from "./labels.ts";
import {
	activeCount,
	applyFilters,
	BUCKETS,
	type Bucket,
	type Filters,
	facet,
	type Row,
	type Sort,
} from "./model.ts";
import { clearFilters, filters, openFeed, setFilter, setSort, sort } from "./state.ts";
import { every } from "./time.ts";
import { VirtualList } from "./VirtualList.tsx";

/** Matches .src-row heights in atlas.css. */
const ROW_WIDE = 60;
const ROW_NARROW = 78;
const WIDE = "(min-width: 900px)";

function useWide(): boolean {
	const [wide, setWide] = useState(() => matchMedia(WIDE).matches);
	useEffect(() => {
		const mq = matchMedia(WIDE);
		const on = () => setWide(mq.matches);
		mq.addEventListener("change", on);
		return () => mq.removeEventListener("change", on);
	}, []);
	return wide;
}

/** Filters, sort and the virtualised list of every feed. */
export function Catalogue({
	rows,
	bucketById,
}: {
	rows: readonly Row[];
	bucketById: ReadonlyMap<string, Bucket>;
}) {
	const l = lang.value;
	const f = filters.value;
	const s = sort.value;
	const wide = useWide();
	const [open, setOpen] = useState(false);
	const hb = healthById.value;
	const shown = useMemo(
		() =>
			applyFilters(
				rows,
				f,
				bucketById,
				s,
				(id) => hb.get(id)?.dataAgeMs ?? hb.get(id)?.fetchAgeMs ?? null,
				l,
			),
		[rows, f, bucketById, s, hb, l],
	);
	const facets = useMemo(
		() => ({
			category: facet(rows, (r) => r.primary),
			region: facet(rows, (r) => r.region),
			kind: facet(rows, (r) => r.kind),
			lang: facet(rows, (r) => r.lang ?? "none"),
			licence: facet(rows, (r) => r.meta.licence.id),
		}),
		[rows],
	);
	const licenceName = useMemo(
		() => new Map(rows.map((r) => [r.meta.licence.id, r.meta.licence.name])),
		[rows],
	);
	const nActive = activeCount(f);
	const nSelects = nActive - (f.q.trim() ? 1 : 0);

	const select = (
		key: Exclude<keyof Filters, "q" | "needsKey">,
		label: string,
		options: { value: string; label: string; n?: number }[],
	) => (
		<label class="cat-filter">
			<span class="cat-filter__label caps">{label}</span>
			<select
				class={`cat-filter__select${f[key] ? " is-set" : ""}`}
				value={f[key] ?? ""}
				onChange={(e) => {
					const v = (e.currentTarget as HTMLSelectElement).value;
					setFilter(key, (v || null) as never);
				}}
			>
				<option value="">{t("Todas", "All")}</option>
				{options.map((o) => (
					<option key={o.value} value={o.value}>
						{o.n !== undefined ? `${o.label} (${o.n})` : o.label}
					</option>
				))}
			</select>
		</label>
	);

	const stateRegions = facets.region.filter((r) => r.value.startsWith("VE-"));
	const regionOptions = [
		...facets.region
			.filter((r) => !r.value.startsWith("VE-"))
			.map((r) => ({ value: r.value, label: regionLabel(r.value, l), n: r.n })),
		...(stateRegions.length
			? [
					{
						value: "state",
						label: regionLabel("state", l),
						n: stateRegions.reduce((a, r) => a + r.n, 0),
					},
				]
			: []),
		...stateRegions
			.map((r) => ({ value: r.value, label: `· ${regionLabel(r.value, l)}`, n: r.n }))
			.sort((a, b) => a.label.localeCompare(b.label, l)),
	];

	return (
		<section class="cat" aria-labelledby="cat-title">
			<div class="cat__bar">
				<div class="cat__search-row">
					<h2 id="cat-title" class="cat__title">
						{t("Catálogo", "Catalogue")}
						<span class="cat__count mono" aria-live="polite">
							{shown.length === rows.length
								? int(rows.length, l)
								: t(
										`${int(shown.length, l)} de ${int(rows.length, l)}`,
										`${int(shown.length, l)} of ${int(rows.length, l)}`,
									)}
						</span>
					</h2>
					<label class="cat__search">
						<span class="sr-only">{t("Buscar fuentes", "Search sources")}</span>
						<svg viewBox="0 0 16 16" aria-hidden="true" class="cat__search-icon">
							<circle cx="7" cy="7" r="4.5" />
							<path d="M10.5 10.5 14 14" />
						</svg>
						<input
							type="search"
							value={f.q}
							placeholder={t(
								`Buscar en ${int(rows.length, l)} fuentes…`,
								`Search ${int(rows.length, l)} sources…`,
							)}
							onInput={(e) => setFilter("q", (e.currentTarget as HTMLInputElement).value)}
							autoComplete="off"
							spellcheck={false}
						/>
					</label>
					<button
						type="button"
						class="cat__more"
						aria-expanded={open}
						aria-controls="cat-filters"
						onClick={() => setOpen(!open)}
					>
						{t("Filtros", "Filters")}
						{nSelects > 0 ? <span class="cat__more-n mono">{nSelects}</span> : null}
					</button>
				</div>
				<div id="cat-filters" class={`cat__filters${open ? " is-open" : ""}`}>
					{select(
						"category",
						t("Categoría", "Category"),
						facets.category.map((c) => ({ value: c.value, label: categoryLabel(c.value, l), n: c.n })),
					)}
					{select("region", t("Región", "Region"), regionOptions)}
					{select(
						"kind",
						t("Tipo", "Type"),
						facets.kind.map((c) => ({ value: c.value, label: kindLabel(c.value, l), n: c.n })),
					)}
					{select(
						"lang",
						t("Idioma", "Language"),
						facets.lang.map((c) => ({ value: c.value, label: langLabel(c.value, l), n: c.n })),
					)}
					{select(
						"licence",
						t("Licencia", "Licence"),
						facets.licence.map((c) => ({
							value: c.value,
							label: licenceName.get(c.value) ?? c.value,
							n: c.n,
						})),
					)}
					{select(
						"bucket",
						t("Estado", "Health"),
						BUCKETS.map((b) => ({ value: b, label: bucketLabel(b, l) })),
					)}
					{f.country ? (
						<button type="button" class="cat-chip" onClick={() => setFilter("country", null)}>
							{countryLabel(f.country, l)} <span aria-hidden="true">×</span>
							<span class="sr-only">{t("quitar", "remove")}</span>
						</button>
					) : null}
					<label class="cat-check">
						<input
							type="checkbox"
							checked={f.needsKey}
							onChange={(e) => setFilter("needsKey", (e.currentTarget as HTMLInputElement).checked)}
						/>
						{t("Necesita clave", "Needs a key")}
					</label>
					<label class="cat-filter cat-filter--sort">
						<span class="cat-filter__label caps">{t("Orden", "Sort")}</span>
						<select
							class="cat-filter__select"
							value={s}
							onChange={(e) => setSort((e.currentTarget as HTMLSelectElement).value as Sort)}
						>
							<option value="category">{t("Categoría", "Category")}</option>
							<option value="name">{t("Nombre", "Name")}</option>
							<option value="fresh">{t("Dato más reciente", "Newest datum")}</option>
							<option value="added">{t("Añadidas hace poco", "Recently added")}</option>
						</select>
					</label>
					{nActive > 0 ? (
						<button type="button" class="link-button cat__clear" onClick={clearFilters}>
							{t("Quitar filtros", "Clear filters")}
						</button>
					) : null}
				</div>
			</div>
			{wide ? (
				<div class="src-head" aria-hidden="true">
					<span>{t("Fuente", "Source")}</span>
					<span>{t("Categoría", "Category")}</span>
					<span>{t("Último dato", "Newest datum")}</span>
					<span>{t("Licencia", "Licence")}</span>
					<span>{t("Alimenta", "Feeds")}</span>
				</div>
			) : null}
			{shown.length ? (
				<VirtualList
					items={shown}
					keyOf={(r) => r.id}
					rowHeight={wide ? ROW_WIDE : ROW_NARROW}
					label={t("Fuentes", "Sources")}
					render={(r) => <SourceRow row={r} h={hb.get(r.id)} bucket={bucketById.get(r.id) ?? "pending"} />}
				/>
			) : rows.length === 0 ? (
				<div class="cat__empty">
					<p>{t("Cargando la lista de fuentes…", "Loading the list of sources…")}</p>
				</div>
			) : (
				<div class="cat__empty">
					<p>{t("Ninguna fuente coincide con estos filtros.", "No source matches these filters.")}</p>
					<button type="button" class="link-button" onClick={clearFilters}>
						{t("Quitar filtros", "Clear filters")}
					</button>
				</div>
			)}
		</section>
	);
}

function SourceRow({ row, h, bucket }: { row: Row; h: FeedHealth | undefined; bucket: Bucket }) {
	const l = lang.value;
	const m = row.meta;
	const age = h?.newestObservedAt ? ago(now.value - h.newestObservedAt, l) : null;
	const late = bucket === "stale" || bucket === "failing";
	const place = row.region.startsWith("VE-") ? regionLabel(row.region, l) : regionLabel(row.region, l);
	return (
		<div class={`src-row src-row--${bucket}`}>
			<div class="src-row__main">
				<span class={`src-dot src-dot--${bucket}`} role="img" aria-label={bucketLabel(bucket, l)} />
				<button
					type="button"
					class="src-row__name"
					onClick={() => {
						openFeed.value = row.id;
					}}
					aria-haspopup="dialog"
				>
					{m.name[l]}
				</button>
				{row.needsKey ? (
					<a class="src-key" href={`${href("guide")}#key-${m.keys[0] ?? ""}`}>
						<svg viewBox="0 0 12 12" aria-hidden="true">
							<rect x="2.5" y="5.5" width="7" height="5" rx="1" />
							<path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" />
						</svg>
						{t("necesita clave", "needs a key")}
					</a>
				) : null}
				<span class="src-row__sub">
					{m.provider !== m.name[l] ? `${m.provider} · ` : ""}
					{place}
					{row.kind ? ` · ${kindLabel(row.kind, l)}` : ""}
				</span>
			</div>
			<div class="src-row__cats">
				{row.category.map((c, i) => (
					<span key={c} class={`src-chip${i === 0 ? " is-primary" : ""}`}>
						{categoryLabel(c, l)}
					</span>
				))}
			</div>
			<div class="src-row__fresh mono">
				<span class={late ? "is-late" : ""}>{age ?? (bucket === "off" ? t("apagada", "off") : "—")}</span>
				<span class="src-row__budget">{every(m.intervalMs, l)}</span>
			</div>
			<div class="src-row__lic">
				<a class="link" href={m.licence.url} target="_blank" rel="noopener noreferrer">
					{m.licence.name}
				</a>
			</div>
			<div class="src-row__panels">{(m.panels ?? []).map((p) => panelLabel(p, l)).join(" · ") || "—"}</div>
		</div>
	);
}
