import { facts } from "@/lib/data";
import { blob, type Lang, num, tr, when } from "@/lib/i18n";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

/** Numbers derived from the code when this version of the site was prepared (scripts/site-data.ts), each with how. */
export function Numbers({ lang }: { lang: Lang }) {
	const t = tr(lang);
	const stats = [
		{
			value: num(lang, facts.sources),
			label: t("fuentes de datos", "data sources"),
			how: t(
				"Adaptadores en src/adapters/registry.ts, cada uno con su licencia y su presupuesto de frescura.",
				"Adapters in src/adapters/registry.ts, each with its licence and its freshness budget.",
			),
		},
		{
			value: num(lang, facts.keyless),
			label: t("sin clave ni cuenta", "with no key and no account"),
			how: t(
				"Adaptadores de src/adapters/registry.ts que no piden clave ni hay que activar.",
				"Adapters in src/adapters/registry.ts that need no key and no opt-in.",
			),
		},
		{
			value: num(lang, facts.newsPublishers),
			label: t("medios de noticias", "news publishers"),
			how: t(
				"Editores distintos entre los adaptadores de la capa de noticias.",
				"Distinct publishers among the news-layer adapters.",
			),
		},
		{
			value: num(lang, facts.panels),
			label: t(`paneles en ${facts.modules.length} módulos`, `panels in ${facts.modules.length} modules`),
			how: t(
				"PANEL_IDS en web/src/lib/layout.ts, repartidos en los módulos de web/src/lib/modules.ts, más el mapa.",
				"PANEL_IDS in web/src/lib/layout.ts, arranged in the modules of web/src/lib/modules.ts, plus the map.",
			),
		},
		{
			value: num(lang, facts.places.total),
			label: t("fichas de lugares e instalaciones", "pages for places and facilities"),
			how: t(
				`Entidades del registro en src/ontology/registry.ts: ${num(lang, facts.places.byType.municipality)} municipios, ${num(lang, facts.places.byType.parish)} parroquias, ${num(lang, facts.places.byType.infrastructure)} instalaciones y más.`,
				`Entities in the registry, src/ontology/registry.ts: ${num(lang, facts.places.byType.municipality)} municipalities, ${num(lang, facts.places.byType.parish)} parishes, ${num(lang, facts.places.byType.infrastructure)} facilities and more.`,
			),
		},
		{
			value: num(lang, facts.tests),
			label: t("pruebas", "tests"),
			how: t(
				`Declaraciones test() en los ${num(lang, facts.testFiles)} archivos *.test.ts del repositorio público; corren en cada commit.`,
				`test() declarations in the public repository's ${num(lang, facts.testFiles)} *.test.ts files; they run on every commit.`,
			),
		},
		{
			value: num(lang, facts.firstLoadKiB, 1),
			unit: "KiB",
			label: t("primera carga de la app", "the app's first load"),
			how: t(
				"gzip de lo que carga index.html, medido por scripts/build-web.ts.",
				"gzip of what index.html loads, measured by scripts/build-web.ts.",
			),
		},
		{
			value: num(lang, facts.licences),
			label: t("licencias distintas", "distinct licences"),
			how: t(
				"Licencias declaradas por los adaptadores; cada cifra muestra la suya.",
				"Licences the adapters declare; every figure shows its own.",
			),
		},
	];
	return (
		<Section
			id="cifras"
			index="06"
			eyebrow={t("En cifras", "By the numbers")}
			title={t(
				"Cifras que salen del código, no de un folleto.",
				"Numbers from the code, not from a brochure.",
			)}
			lede={t(
				"Cada número de esta sección se calculó a partir del repositorio al preparar esta versión del sitio. Debajo de cada uno, cómo.",
				"Every number in this section was computed from the repository when this version of the site was prepared. Under each one, how.",
			)}
		>
			<dl className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
				{stats.map((s, i) => (
					<Reveal key={s.label} delay={(i % 4) * 0.05} className="flex flex-col bg-bg p-7 sm:p-8">
						<dt className="order-2 mt-1 text-[1rem] font-medium text-text">{s.label}</dt>
						<dd className="order-1 flex items-baseline gap-1.5">
							<span className="text-[clamp(2.5rem,1.9rem+2vw,3.25rem)] font-semibold leading-none tracking-[-0.045em]">
								{s.value}
							</span>
							{s.unit ? <span className="text-[1.125rem] text-text-3">{s.unit}</span> : null}
						</dd>
						<dd className="order-3 mt-4 text-[0.8125rem] leading-relaxed text-text-3">{s.how}</dd>
					</Reveal>
				))}
			</dl>
			<p className="data mt-5 text-[0.75rem] text-text-3">
				{t("Calculado el ", "Computed on ")}
				{when(lang, facts.generatedAt)}
				{t(" (hora de Caracas), versión ", " (Caracas time), version ")}
				{facts.version}
				{t(" · el guion: ", " · the script: ")}
				<a className="link" href={blob("scripts/site-data.ts")} target="_blank" rel="noopener noreferrer">
					scripts/site-data.ts
				</a>
			</p>
		</Section>
	);
}
