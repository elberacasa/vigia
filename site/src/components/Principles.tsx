import { apiFigure, facts } from "@/lib/data";
import { type Lang, num, tr, when } from "@/lib/i18n";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

/** One real figure, as the API served it when this version of the site was prepared, taken apart. */
function Anatomy({ lang }: { lang: Lang }) {
	const t = tr(lang);
	const { figure } = apiFigure();
	const rows: [string, string, string?][] = [
		[t("Fuente", "Source"), figure.attribution.replace(/^Fuente: /, "")],
		[t("Vale desde", "Valid from"), when(lang, figure.observedAt)],
		[t("Vigía la obtuvo", "Vigía fetched it"), when(lang, figure.fetchedAt)],
		[t("Licencia", "Licence"), facts.figureLicence.name, facts.figureLicence.url],
		[
			t("Original", "Original"),
			figure.sourceUrl.replace(/^https?:\/\//, "").replace(/\/$/, ""),
			figure.sourceUrl,
		],
		[
			t("Estado", "State"),
			figure.stale
				? t("desactualizada", "stale")
				: t("al día, dentro de su presupuesto", "current, within its budget"),
		],
	];
	return (
		<Reveal className="card mt-14 grid overflow-hidden md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
			<div className="relative flex flex-col justify-between gap-10 border-b border-line p-7 sm:p-9 md:border-b-0 md:border-r">
				<div>
					<p className="eyebrow">{t("Anatomía de una cifra", "Anatomy of a figure")}</p>
					<p className="mt-2 text-[0.9375rem] text-text-2">
						{t("Dólar oficial, BCV", "Official dollar, BCV")}
					</p>
				</div>
				<p className="flex items-baseline gap-2">
					<span className="text-[clamp(3rem,2rem+4vw,4.5rem)] font-semibold leading-none tracking-[-0.04em]">
						{num(lang, figure.value, 2)}
					</span>
					<span className="text-[1.25rem] text-text-3">Bs</span>
				</p>
				<p className="flex items-center gap-2 text-[0.8125rem] text-text-2">
					<span className="h-2 w-2 rounded-full bg-ok" aria-hidden="true" />
					<span className="data">BCV · {when(lang, figure.observedAt, false)}</span>
				</p>
			</div>
			<div>
				<dl className="divide-y divide-line border-b border-line">
					{rows.map(([k, v, href]) => (
						<div key={k} className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-4 px-7 py-3.5 sm:px-9">
							<dt className="text-[0.8125rem] text-text-3">{k}</dt>
							<dd className="data min-w-0 break-words text-[0.8125rem] text-text">
								{href ? (
									<a className="link" href={href} target="_blank" rel="noopener noreferrer">
										{v}
									</a>
								) : (
									v
								)}
							</dd>
						</div>
					))}
				</dl>
				<p className="px-7 py-4 text-[0.75rem] leading-relaxed text-text-3 sm:px-9">
					{t(
						"Tal como la sirvió /api/v1/panels/money/figures al preparar esta versión del sitio. En la app, cada cifra se abre así con un toque.",
						"Exactly as /api/v1/panels/money/figures served it when this version of the site was prepared. In the app, every figure opens like this with one tap.",
					)}
				</p>
			</div>
		</Reveal>
	);
}

export function Principles({ lang }: { lang: Lang }) {
	const t = tr(lang);
	const items = [
		[
			t("Cada cifra, con su fuente y su hora", "Every figure, with its source and its time"),
			t(
				"Quién la publicó, cuándo valía, cuándo llegó, su licencia y el enlace al original. Sin excepción.",
				"Who published it, when it was valid, when it arrived, its licence and a link to the original. No exceptions.",
			),
		],
		[
			t("Lo viejo nunca parece nuevo", "Stale never passes for live"),
			t(
				"Cada fuente tiene un presupuesto de frescura. Si falla, ves el último dato bueno con su edad real y una marca de desactualizado; la página de estado dice qué falla.",
				"Every source has a freshness budget. If it fails, you see the last good value with its real age and a stale mark; the status page says what is failing.",
			),
		],
		[
			t("Los números son código, no un modelo", "Numbers are code, never a model"),
			t(
				"Tasas, brechas, conteos y cambios salen de código determinista con pruebas. Ningún modelo inventa ni redondea una cifra.",
				"Rates, gaps, counts and changes come from deterministic, tested code. No model invents or rounds a figure.",
			),
		],
		[
			t("Cifras en disputa, lado a lado", "Contested figures, side by side"),
			t(
				"La tasa oficial junto a las paralelas, cada una con su nombre; lo oficial junto a lo independiente. Nunca un número mezclado.",
				"The official rate beside the parallel ones, each with its name; official beside independent. Never one blended number.",
			),
		],
		[
			t("Hechos y lugares, no personas", "Events and places, not people"),
			t(
				"Sin nombres, caras ni cuentas de particulares; sin rastrear aviones ni barcos militares. Y a ti tampoco: sin cuenta, sin analítica, sin rastreo.",
				"No names, faces or handles of private people; no tracking of military aircraft or ships. Nor of you: no account, no analytics, no tracking.",
			),
		],
		[
			t("La IA es opcional y va etiquetada", "AI is optional, and labelled"),
			t(
				"El núcleo no usa IA. Si la activas, clasifica y resume con su precisión medida a la vista, enlaza sus fuentes y gasta solo el presupuesto que fijes.",
				"The core uses no AI. If you turn it on, it classifies and summarises with its measured accuracy shown, links its sources and spends only the budget you set.",
			),
		],
	] as const;
	return (
		<Section
			id="principios"
			index="04"
			eyebrow={t("Principios", "Principles")}
			title={t(
				"Lo que Vigía nunca hace es lo que la hace útil.",
				"What Vigía never does is what makes it useful.",
			)}
			lede={t(
				"Muchos tableros ganan con ambiente: rojo, parpadeos, cifras sin origen. Vigía gana con lo contrario: calma, fuentes y horas.",
				"Many dashboards win on atmosphere: red, blinking, figures from nowhere. Vigía wins on the opposite: calm, sources and times.",
			)}
		>
			<Anatomy lang={lang} />
			<ol className="mt-6 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
				{items.map(([title, text], i) => (
					<Reveal as="li" key={title} delay={(i % 3) * 0.05} className="bg-bg p-7 sm:p-8">
						<span className="data text-[0.75rem] text-text-3">{String(i + 1).padStart(2, "0")}</span>
						<h3 className="mt-4 text-[1.125rem] font-semibold leading-snug tracking-[-0.01em]">{title}</h3>
						<p className="mt-2.5 text-[0.9375rem] leading-relaxed text-text-2">{text}</p>
					</Reveal>
				))}
			</ol>
		</Section>
	);
}
