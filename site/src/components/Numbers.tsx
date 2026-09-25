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
				`Adaptadores en src/adapters/registry.ts; ${num(lang, facts.keyless)} funcionan sin clave.`,
				`Adapters in src/adapters/registry.ts; ${num(lang, facts.keyless)} work with no key.`,
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
			label: t("paneles en el muro", "panels on the wall"),
			how: t(
				"PANEL_IDS en web/src/lib/layout.ts, más el mapa.",
				"PANEL_IDS in web/src/lib/layout.ts, plus the map.",
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
			index="04"
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
			<dl className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
				{stats.map((s, i) => (
					<Reveal key={s.label} delay={(i % 3) * 0.05} className="flex flex-col bg-bg p-7 sm:p-8">
						<dt className="order-2 mt-1 text-[1rem] font-medium text-text">{s.label}</dt>
						<dd className="order-1 flex items-baseline gap-1.5">
							<span className="text-[clamp(2.75rem,2rem+2.4vw,3.75rem)] font-semibold leading-none tracking-[-0.045em]">
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
