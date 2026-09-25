import Image from "next/image";
import media from "@/data/media.json";
import { facts } from "@/lib/data";
import { type Lang, num, tr, when } from "@/lib/i18n";
import { media as file } from "@/lib/media";
import { Recording } from "./Recording";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

/** What each chapter of the recording shows (scripts/site-capture.ts, in its order), for readers who cannot watch. */
const SCENES: readonly (readonly [string, string])[] = [
	[
		"El muro en una pantalla de escritorio: la frase «Ahora», el mapa por estados y los paneles.",
		"The wall on a desktop screen: the “Ahora” sentence, the map by state and the panels.",
	],
	[
		"Un clic en Sucre: el mapa se acerca al estado y se abre su ficha.",
		"A click on Sucre: the map zooms to the state and its sheet opens.",
	],
	[
		"Ctrl K abre la búsqueda; al escribir «maracaibo» y pulsar Enter, la pantalla va a ese municipio.",
		"Ctrl K opens the search; typing “maracaibo” and pressing Enter takes the screen to that municipality.",
	],
	[
		"En la franja del historial se eligen 7 días y se reproducen los datos guardados de esa semana.",
		"In the history strip, 7 days are chosen and the week's stored data is played back.",
	],
	[
		"La vista del teléfono: se desliza por los paneles y se tocan las pestañas Dólar y Mapa.",
		"The phone view: scrolling through the panels, then tapping the Dollar and Map tabs.",
	],
];

export function HowItWorks({ lang }: { lang: Lang }) {
	const t = tr(lang);
	const steps = [
		{
			n: "1",
			title: t("Lee fuentes públicas", "Reads public sources"),
			text: t(
				`${num(lang, facts.sources)} fuentes: el BCV, USGS y FUNVISIS, NASA, IODA, OONI, Open-Meteo, ${num(lang, facts.newsPublishers)} medios y más. ${num(lang, facts.keyless)} funcionan sin clave ni cuenta.`,
				`${num(lang, facts.sources)} sources: the central bank, USGS and FUNVISIS, NASA, IODA, OONI, Open-Meteo, ${num(lang, facts.newsPublishers)} publishers and more. ${num(lang, facts.keyless)} work with no key and no account.`,
			),
		},
		{
			n: "2",
			title: t("Calcula en código y guarda todo", "Computes in code, keeps everything"),
			text: t(
				"Cada respuesta se valida, se normaliza y se archiva con su historia. Brechas, cambios y conteos salen de código probado, no de un modelo.",
				"Every response is validated, normalised and archived with its history. Gaps, changes and counts come from tested code, not from a model.",
			),
		},
		{
			n: "3",
			title: t("Te lo muestra con su fuente y su hora", "Shows it with its source and its time"),
			text: t(
				"Un mapa y paneles que se leen en diez segundos. Toca cualquier cifra: quién la publicó, cuándo valía, cuándo llegó, su licencia y el enlace.",
				"A map and panels you read in ten seconds. Tap any figure: who published it, when it was valid, when it arrived, its licence and the link.",
			),
		},
	];
	return (
		<Section
			id="como-funciona"
			index="01"
			eyebrow={t("Cómo funciona", "How it works")}
			title={t(
				"Una sala de situación que corre en tu computadora.",
				"A situation room that runs on your computer.",
			)}
			lede={t(
				"Descargas un archivo, lo abres y Vigía empieza a leer. Sin servidor de nadie en el medio: tus datos, tus claves y tu historial se quedan contigo.",
				"Download one file, open it, and Vigía starts reading. No one else's server in between: your data, your keys and your history stay with you.",
			)}
		>
			<Reveal className="mt-14">
				<Recording
					lang={lang}
					chapters={media.chapters}
					poster={file("poster.webp")}
					sources={{ webm: file("hero.webm"), mp4: file("hero.mp4") }}
					label={t(
						"Grabación de Vigía en uso: el muro, un estado en el mapa, la búsqueda de Maracaibo, el historial de internet reproducido y la vista del teléfono.",
						"Recording of Vigía in use: the wall, a state on the map, a search for Maracaibo, the internet history replayed and the phone view.",
					)}
				/>
				<p className="data mt-3 text-[0.75rem] text-text-3">
					{t(
						`Grabación real de Vigía con sus datos del ${when(lang, media.recordedAt)} (hora de Caracas). ${num(lang, Math.round(media.duration))} s, sin audio, sin montaje de datos.`,
						`A real recording of Vigía with its data of ${when(lang, media.recordedAt)} (Caracas time). ${num(lang, Math.round(media.duration))} s, no audio, no staged data.`,
					)}
				</p>
				<details className="mt-3 text-[0.875rem] text-text-2">
					<summary className="w-fit cursor-pointer rounded-md text-text-3 transition-colors hover:text-text">
						{t("La grabación, en texto", "The recording, as text")}
					</summary>
					<ol className="mt-3 max-w-3xl space-y-2 leading-relaxed">
						{media.chapters.map((c, i) => (
							<li key={c.at} className="flex gap-3">
								<span className="data w-10 shrink-0 text-[0.75rem] leading-[1.6rem] text-text-3">
									0:{String(Math.floor(c.at)).padStart(2, "0")}
								</span>
								<span>
									{SCENES[i] ? (lang === "es" ? SCENES[i][0] : SCENES[i][1]) : lang === "es" ? c.es : c.en}
								</span>
							</li>
						))}
					</ol>
				</details>
			</Reveal>

			<ol className="mt-16 grid gap-px overflow-hidden rounded-2xl border border-line bg-line md:grid-cols-3">
				{steps.map((s, i) => (
					<Reveal as="li" key={s.n} delay={i * 0.06} className="bg-bg p-7 sm:p-8">
						<span className="data grid h-8 w-8 place-items-center rounded-full border border-line-strong text-[0.8125rem] text-text-2">
							{s.n}
						</span>
						<h3 className="mt-5 text-[1.1875rem] font-semibold tracking-[-0.01em]">{s.title}</h3>
						<p className="mt-2.5 text-[0.9375rem] leading-relaxed text-text-2">{s.text}</p>
					</Reveal>
				))}
			</ol>

			<div className="mt-16 grid items-end gap-6 lg:grid-cols-[minmax(0,2.35fr)_minmax(0,0.65fr)]">
				<Reveal>
					<figure>
						<div className="frame">
							<Image
								src={file("still-desk.webp")}
								alt={t(
									"Vigía en una pantalla de escritorio: la frase Ahora, las cifras clave, el mapa por estados y los paneles de dólar, internet e incidentes.",
									"Vigía on a desktop screen: the Ahora sentence, the key figures, the map by state and the dollar, internet and incidents panels.",
								)}
								width={2880}
								height={1800}
								sizes="(min-width: 1216px) 880px, (min-width: 1024px) 72vw, 100vw"
								className="h-auto w-full"
							/>
						</div>
						<figcaption className="mt-3 text-[0.8125rem] text-text-3">
							{t("En el escritorio: el muro completo.", "On a desktop: the full wall.")}
						</figcaption>
					</figure>
				</Reveal>
				<Reveal delay={0.08} className="mx-auto w-full max-w-[17rem] lg:max-w-none">
					<figure>
						<div className="frame !rounded-[1.75rem]">
							<Image
								src={file("still-phone.webp")}
								alt={t(
									"Vigía en un teléfono: la frase Ahora, incidentes, el dólar y el mapa, con la barra de secciones abajo.",
									"Vigía on a phone: the Ahora sentence, incidents, the dollar and the map, with the section bar at the bottom.",
								)}
								width={780}
								height={1688}
								sizes="(min-width: 1024px) 260px, 272px"
								className="h-auto w-full"
							/>
						</div>
						<figcaption className="mt-3 text-[0.8125rem] text-text-3">
							{t(
								`En el teléfono, también: ${num(lang, facts.firstLoadKiB, 1)} KiB de primera carga.`,
								`On a phone, too: a ${num(lang, facts.firstLoadKiB, 1)} KiB first load.`,
							)}
						</figcaption>
					</figure>
				</Reveal>
			</div>
		</Section>
	);
}
