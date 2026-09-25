import { type SourceRow, sources } from "@/lib/catalog";
import { facts } from "@/lib/data";
import { blob, type Lang, num, tr, when } from "@/lib/i18n";
import { AccessTag } from "./Access";
import { Count } from "./Count";
import { SourceFilter } from "./SourceFilter";
import { StateMap } from "./StateMap";

const collator = new Intl.Collator("es", { sensitivity: "base", numeric: true });

function where(lang: Lang, r: SourceRow): string {
	const t = tr(lang);
	if (r.region.startsWith("VE-")) return sources.states.find((s) => s.iso === r.region)?.name ?? r.region;
	if (r.region === "diaspora") return t("Diáspora", "Diaspora");
	// "No single country" (a global network, a UN body) says nothing a reader needs on every row.
	return r.cc === "INT" ? "" : r.country[lang];
}

function Row({ lang, r }: { lang: Lang; r: SourceRow }) {
	const t = tr(lang);
	const name = r.name[lang];
	// The provider line: who publishes it, where, and (outlets) its stance; the name already says it for most outlets.
	const provider = r.provider !== name && !name.startsWith(r.provider) ? r.provider : null;
	const meta = [provider, where(lang, r), r.stance?.[lang]].filter(Boolean).join(" · ");
	const state = r.region.startsWith("VE-") ? r.region : "";
	return (
		<li className="src" data-a={r.access} data-r={state}>
			<a href={r.homepage} target="_blank" rel="noopener noreferrer" className="src__link">
				<span className="src__name">{name}</span>
				<span className="src__meta">{meta}</span>
				<span className="sr-only">{t(" (se abre en otra pestaña)", " (opens in a new tab)")}</span>
			</a>
			<span className="src__side">
				<span className="src__kind" title={r.licence.name}>
					{r.kind[lang]}
				</span>
				<AccessTag lang={lang} access={r.access} quiet={r.access === "free"} />
			</span>
		</li>
	);
}

/** /fuentes: every source Vigía reads, grouped, searchable, each linking to its publisher. */
export function SourcesPage({ lang }: { lang: Lang }) {
	const t = tr(lang);
	const s = sources;
	const stats = [
		{ value: s.total, label: t("fuentes", "sources") },
		{ value: s.free, label: t("sin ninguna clave", "with no key at all") },
		{ value: s.outlets, label: t("medios de noticias", "news publishers") },
		{ value: s.licences, label: t("licencias distintas", "distinct licences") },
	];
	const max = Math.max(...s.groups.map((g) => g.count));
	const regional = s.states.filter((x) => x.outlets > 0).sort((a, b) => b.outlets - a.outlets);
	return (
		<>
			<section className="relative isolate overflow-hidden pb-16 pt-32 sm:pt-36" aria-labelledby="page-title">
				<div className="graticule absolute inset-0 -z-10 [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,black,transparent)]" />
				<div className="wrap">
					<p className="eyebrow">{t("Fuentes", "Sources")}</p>
					<h1 id="page-title" className="h-display mt-5 max-w-4xl text-[clamp(2.5rem,1.4rem+3.8vw,4.25rem)]">
						{t(
							`${num(lang, s.total)} fuentes. Todas con nombre, licencia y enlace.`,
							`${num(lang, s.total)} sources. Every one with a name, a licence and a link.`,
						)}
					</h1>
					<p className="lede mt-6 max-w-2xl">
						{t(
							"Todo lo que Vigía lee, de dónde viene y con qué permiso. Cada cifra de la app muestra su fuente; esta es la lista completa, generada del código de esta versión.",
							"Everything Vigía reads, where it comes from and under which terms. Every figure in the app shows its source; this is the full list, generated from this version's code.",
						)}
					</p>
					<dl className="mt-12 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-4">
						{stats.map((x) => (
							<div key={x.label} className="flex flex-col bg-bg p-6 sm:p-7">
								<dt className="order-2 mt-1.5 text-[0.9375rem] text-text-2">{x.label}</dt>
								<dd className="order-1 text-[clamp(2.25rem,1.6rem+2vw,3.5rem)] font-semibold leading-none tracking-[-0.045em]">
									<Count lang={lang} value={x.value} />
								</dd>
							</div>
						))}
					</dl>
					<p className="data mt-4 text-[0.75rem] text-text-3">
						{t("Generado el ", "Generated on ")}
						{when(lang, facts.generatedAt)}
						{t(" (hora de Caracas) desde la versión ", " (Caracas time) from version ")}
						{facts.version}
						{" · "}
						<a
							className="link"
							href={blob("scripts/site/sources.ts")}
							target="_blank"
							rel="noopener noreferrer"
						>
							scripts/site/sources.ts
						</a>
					</p>
				</div>
			</section>

			<section className="pb-16" aria-labelledby="overview-title">
				<h2 id="overview-title" className="sr-only">
					{t("Panorama", "Overview")}
				</h2>
				<div className="wrap grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
					<nav aria-label={t("Grupos", "Groups")} className="card p-5 sm:p-7">
						<h3 className="text-[1.0625rem] font-semibold">{t("Por grupo", "By group")}</h3>
						<ul className="mt-5 space-y-1">
							{s.groups.map((g) => (
								<li key={g.id}>
									<a href={`#${g.slug}`} className="bar">
										<span className="bar__label">{g.name[lang]}</span>
										<span className="bar__track" aria-hidden="true">
											<span className="bar__fill" style={{ width: `${(g.count / max) * 100}%` }} />
										</span>
										<span className="data bar__n">{num(lang, g.count)}</span>
									</a>
								</li>
							))}
						</ul>
					</nav>
					<div className="card flex flex-col p-5 sm:p-7">
						<h3 className="text-[1.0625rem] font-semibold">
							{t("Medios regionales por estado", "Regional outlets by state")}
						</h3>
						<p className="mt-1 text-[0.875rem] text-text-2">
							{t("Toca un estado para ver sus medios.", "Click a state to see its outlets.")}
						</p>
						<StateMap lang={lang} className="mx-auto mt-4 max-w-[30rem] cursor-pointer" />
						<p className="mt-4 text-[0.8125rem] leading-relaxed text-text-3">
							{regional.map((x, i) => (
								<span key={x.iso}>
									{x.name} <span className="data text-text-2">{x.outlets}</span>
									{i < regional.length - 1 ? " · " : ""}
								</span>
							))}
						</p>
					</div>
				</div>
			</section>

			<section id="catalogo" aria-labelledby="catalogue-title" className="pb-24">
				<div className="wrap">
					<h2 id="catalogue-title" className="sr-only">
						{t("Catálogo", "Catalogue")}
					</h2>
					<SourceFilter
						lang={lang}
						total={s.total}
						states={regional.map((x) => ({ iso: x.iso, name: x.name, n: x.outlets }))}
						groups={s.groups.map((g) => ({ slug: g.slug, name: g.name[lang] }))}
					/>
					{s.groups.map((g) => {
						const rows = s.rows
							.filter((r) => r.group === g.id)
							.sort((a, b) => collator.compare(a.name[lang], b.name[lang]));
						return (
							<section
								key={g.id}
								id={g.slug}
								className="src-group scroll-mt-40 pt-12"
								aria-labelledby={`${g.slug}-title`}
								data-g={g.slug}
							>
								<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line pb-3">
									<h3 id={`${g.slug}-title`} className="text-[1.25rem] font-semibold tracking-[-0.01em]">
										{g.name[lang]}
									</h3>
									<span className="data text-[0.8125rem] text-text-3">
										<span data-shown>{num(lang, g.count)}</span>
									</span>
									<span className="basis-full text-[0.875rem] text-text-3 sm:ml-auto sm:basis-auto">
										{g.note[lang]}
									</span>
								</div>
								<ul className="src-list">
									{rows.map((r) => (
										<Row key={r.id} lang={lang} r={r} />
									))}
								</ul>
							</section>
						);
					})}
					<p id="sin-resultados" className="hidden py-16 text-center text-text-2" role="status">
						{t("Ninguna fuente coincide con ese filtro.", "No source matches that filter.")}
					</p>
					<div className="mt-16 max-w-3xl space-y-3 border-t border-line pt-6 text-[0.875rem] leading-relaxed text-text-3">
						<p>
							{t(
								"Los enlaces llevan a la página de cada editor; sus nombres y marcas son suyos, y Vigía no está afiliado a ninguno. Pasa el cursor sobre el tipo de fuente para ver su licencia; la app la muestra junto a cada cifra.",
								"Links go to each publisher's own page; their names and marks are theirs, and Vigía is affiliated with none of them. Hover over a source's type to see its licence; the app shows it beside every figure.",
							)}
						</p>
						<p>
							{t(
								"El detalle técnico de cada fuente (URL, frecuencia, frescura) está en ",
								"Each source's technical detail (URL, interval, freshness) is in ",
							)}
							<a
								className="link"
								href={blob("docs/DATA-SOURCES.md")}
								target="_blank"
								rel="noopener noreferrer"
							>
								docs/DATA-SOURCES.md
							</a>
							{t(
								", y la app trae su propio catálogo en /fuentes, con el estado en vivo de cada una.",
								", and the app has its own catalogue at /fuentes, with each one's live health.",
							)}
						</p>
					</div>
				</div>
			</section>
		</>
	);
}
