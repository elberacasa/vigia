import Image from "next/image";
import { facts } from "@/lib/data";
import { type Lang, num, tr } from "@/lib/i18n";
import { media } from "@/lib/media";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

interface Card {
	/** Wall panel id (web/src/lib/layout.ts): the crop's file name. */
	id: string;
	/** Server panel ids whose publishers are listed (src/server/panel-registry.ts). */
	sources: readonly string[];
	es: [string, string];
	en: [string, string];
	wide?: boolean;
}

const CARDS: readonly Card[] = [
	{
		id: "dinero",
		sources: ["money"],
		wide: true,
		es: [
			"Dólar: BCV y paralelo",
			"La tasa oficial del BCV y cotizaciones paralelas de fuentes con nombre, lado a lado. La brecha la calcula el código; nunca hay una “tasa Vigía”.",
		],
		en: [
			"Dollar: BCV and parallel",
			"The central bank's official rate and parallel quotes from named sources, side by side. Code computes the gap; there is never a “Vigía rate”.",
		],
	},
	{
		id: "conectividad",
		sources: ["connectivity"],
		wide: true,
		es: [
			"Internet por estado",
			"Caídas de señal por estado y por operadora, medidas por redes independientes contra lo normal a esa hora, con su historial.",
		],
		en: [
			"Internet by state",
			"Signal drops by state and by ISP, measured by independent networks against what is normal at that hour, with their history.",
		],
	},
	{
		id: "censura",
		sources: ["censorship"],
		es: [
			"Censura y bloqueos",
			"Qué sitios están bloqueados, cómo y desde cuándo, según mediciones de OONI y VE sin Filtro.",
		],
		en: [
			"Censorship and blocks",
			"Which sites are blocked, how and since when, from OONI and VE sin Filtro measurements.",
		],
	},
	{
		id: "sismos",
		sources: ["quakes"],
		es: [
			"Sismos",
			"USGS y FUNVISIS en una sola lista, cada sismo con su lugar, su magnitud y quién lo reportó.",
		],
		en: [
			"Earthquakes",
			"USGS and FUNVISIS in one list, each quake with its place, its magnitude and who reported it.",
		],
	},
	{
		id: "clima",
		sources: ["weather"],
		es: ["Clima", "Lluvia y tormentas previstas por capital de estado para las próximas 24 horas."],
		en: ["Weather", "Rain and storms forecast for every state capital over the next 24 hours."],
	},
	{
		id: "incendios",
		sources: ["fires"],
		es: [
			"Incendios",
			"Focos de calor vistos por satélite, separando los probables incendios de los mechurrios.",
		],
		en: ["Fires", "Heat detections seen from orbit, telling likely fires apart from gas flares."],
	},
	{
		id: "luces",
		sources: ["nightlights"],
		es: ["Luces nocturnas", "La luz de noche por estado desde el satélite: la señal lenta de un apagón."],
		en: ["Night lights", "Night-time light by state from orbit: the slow signal of a blackout."],
	},
	{
		id: "energia",
		sources: ["oil", "energy"],
		es: [
			"Petróleo y energía",
			"Brent y WTI, y los mechurrios de refinerías y campos con nombre, vistos desde el espacio.",
		],
		en: ["Oil and energy", "Brent and WTI, and gas flaring at named refineries and fields, seen from space."],
	},
	{
		id: "mercados",
		sources: ["markets"],
		es: ["Mercados y carga", "Monedas vecinas, alimentos y materias primas, y el tráfico de los puertos."],
		en: ["Markets and cargo", "Neighbouring currencies, food and commodities, and port traffic."],
	},
	{
		id: "humanitario",
		sources: ["humanitarian"],
		es: [
			"Salud y migración",
			"Boletines de salud, la migración según ACNUR y R4V, y la ayuda que llega, cada cifra con su fuente.",
		],
		en: [
			"Health and migration",
			"Health bulletins, migration from UNHCR and R4V, and the aid that arrives, each figure sourced.",
		],
	},
	{
		id: "servicios",
		sources: ["services"],
		es: [
			"Servicios",
			"El nivel del embalse de Guri por satélite, con una clave gratuita de DAHITI. Lo que no tiene fuente medible, lo dice.",
		],
		en: [
			"Services",
			"The Guri reservoir's level from satellites, with a free DAHITI key. Where nothing can be measured, it says so.",
		],
	},
	{
		id: "gaceta",
		sources: ["gazette"],
		es: [
			"Gaceta Oficial",
			"Los números nuevos y sus actos, en las palabras del índice oficial: actos sobre funcionarios públicos con sus nombres; pensiones y asuntos de particulares, solo contados.",
		],
		en: [
			"Official Gazette",
			"New issues and their acts, in the official index's words: acts about public officials with their names; pensions and private matters, only counted.",
		],
	},

	{
		id: "tv",
		sources: ["livetv"],
		es: [
			"TV y radio",
			"Qué canales y emisoras transmiten ahora, medido; si no se midió, no dice “al aire”. Se activa en /guia.",
		],
		en: [
			"TV and radio",
			"Which channels and stations are on air now, measured; if unmeasured, it never says “on air”. Turned on at /guia.",
		],
	},
	{
		id: "bolsillo",
		sources: ["pocket", "gazette"],
		es: [
			"Tu bolsillo",
			"Cuánto es en dólares y cuánto vale el sueldo: cada tasa con su nombre y su fecha, nunca promediada, y el salario mínimo de la Gaceta.",
		],
		en: [
			"Your pocket",
			"What it is in dollars and what a salary is worth: every rate named and dated, never averaged, and the minimum wage from the Gazette.",
		],
	},

	{
		id: "noticias",
		sources: [],
		wide: true,
		es: [
			"Noticias",
			"Titulares de todo el espectro, cada medio con su línea editorial indicada, ubicados por estado y agrupados en historias.",
		],
		en: [
			"News",
			"Headlines from across the spectrum, each outlet's stance labelled, placed by state and grouped into stories.",
		],
	},
	{
		id: "incidentes",
		sources: ["incidents"],
		wide: true,
		es: [
			"Incidentes",
			"Un incidente se abre solo cuando fuentes independientes coinciden en el mismo lugar y momento, con la regla a la vista. Nunca una probabilidad.",
		],
		en: [
			"Incidents",
			"An incident opens only when independent sources agree on the same place and time, with the rule shown. Never a probability.",
		],
	},
];

/** The wall's other panels, named in the sentence under the grid. */
const MORE: Readonly<Record<string, readonly [string, string]>> = {
	alertas: ["alertas de ciclones y desastres", "cyclone and disaster alerts"],
	satelite: ["imágenes de satélite cada 10 minutos", "satellite imagery every 10 minutes"],
	red: ["rutas de red y evasión de bloqueos", "network routes and circumvention"],
	"espacio-aereo": ["avisos de espacio aéreo", "airspace notices"],
	atencion: ["la atención internacional", "international attention"],
};

/** Publisher names as the adapters write them (Spanish), in English where the words are ours, not a proper name. */
const ENGLISH: readonly (readonly [RegExp, string])[] = [
	[/ y Reserva Federal/, " and Federal Reserve"],
	[/ vía /, " via "],
	[/\(vía /, "(via "],
	[/^Banco Mundial$/, "World Bank"],
	[/^FMI /, "IMF "],
	[/^Ministerio del Poder Popular para la Salud$/, "Ministry of Health (MPPS)"],
	[/^Organización Mundial de la Salud/, "World Health Organization"],
	[/^R4V \(ACNUR y OIM\)$/, "R4V (UNHCR and IOM)"],
	[/^ACNUR \(UNHCR\)$/, "UNHCR"],
	[/\(Gaceta Oficial\)/, "(Official Gazette)"],
	[/^Emisoras$/, "Radio stations"],
];
const english = (name: string) => ENGLISH.reduce((n, [re, to]) => n.replace(re, to), name);

function publishers(lang: Lang, card: Card): string {
	if (card.id === "incidentes")
		return lang === "es"
			? "Sensores independientes (IODA, RIPE NCC, NASA, USGS, FUNVISIS…) y los medios"
			: "Independent sensors (IODA, RIPE NCC, NASA, USGS, FUNVISIS…) and the press";
	if (card.id === "noticias")
		return lang === "es"
			? `${num(lang, facts.newsPublishers)} medios y organizaciones`
			: `${num(lang, facts.newsPublishers)} publishers`;
	const off = facts.offByDefault as Record<string, "key" | "opt-in">;
	const names = [
		...new Set(card.sources.flatMap((s) => (facts.providers as Record<string, string[]>)[s] ?? [])),
	].map((n) => {
		const name = n.replace(/,? medido por Vigía$/, "").replace(/ \((?:páginas|sus propios)[^)]*\)/, "");
		const shown = lang === "en" ? english(name) : name;
		const mark = off[n];
		if (mark === "key") return `${shown} ${lang === "es" ? "(con clave)" : "(with a key)"}`;
		if (mark === "opt-in") return `${shown} ${lang === "es" ? "(opcional)" : "(opt-in)"}`;
		return shown;
	});
	const shown = names.slice(0, 4).join(" · ");
	const more = names.length - 4;
	return more > 0 ? `${shown} ${lang === "es" ? `y ${more} más` : `and ${more} more`}` : shown;
}

export function Panels({ lang }: { lang: Lang }) {
	const t = tr(lang);
	const shown = new Set([...CARDS.map((c) => c.id), "petroleo"]);
	const rest = facts.panelIds.filter((id) => !shown.has(id));
	const restNames = rest.map((id) => {
		const name = MORE[id];
		if (!name) throw new Error(`Panels: no name for the wall panel "${id}"; add it to MORE or to CARDS`);
		return lang === "es" ? name[0] : name[1];
	});
	return (
		<Section
			id="que-muestra"
			index="02"
			eyebrow={t("Qué muestra", "What it shows")}
			title={t(
				`${num(lang, facts.panels)} paneles y un mapa. Cada uno responde una pregunta.`,
				`${num(lang, facts.panels)} panels and a map. Each answers one question.`,
			)}
			lede={t(
				"¿A cuánto está el dólar? ¿Hay caídas de internet? ¿Tembló? Recortes reales de la app, con los nombres de quien publica cada dato.",
				"What is the dollar at? Is the internet down? Was there a quake? Real crops of the app, with the names of whoever publishes each figure.",
			)}
		>
			<ul className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
				{CARDS.map((c, i) => {
					const [title, text] = lang === "es" ? c.es : c.en;
					return (
						<Reveal
							as="li"
							key={c.id}
							delay={(i % 3) * 0.05}
							className={`card group flex flex-col overflow-hidden transition-colors hover:border-line-strong ${
								c.wide ? "lg:col-span-3" : "lg:col-span-2"
							}`}
						>
							<div className="relative overflow-hidden border-b border-line bg-surface-0">
								{/* The crop in the page's theme: the other one is display:none, and lazy, so never fetched. */}
								{(["dark", "light"] as const).map((theme) => (
									<Image
										key={theme}
										src={media(`crops/${c.id}${theme === "light" ? "-light" : ""}.webp`)}
										alt=""
										width={720}
										height={446}
										sizes={
											c.wide
												? "(min-width: 1024px) 580px, (min-width: 640px) 50vw, 100vw"
												: "(min-width: 1024px) 380px, (min-width: 640px) 50vw, 100vw"
										}
										className={`only-${theme} h-auto w-full transition-transform duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-[1.015]`}
									/>
								))}
								<div
									className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-surface-1 to-transparent"
									aria-hidden="true"
								/>
							</div>
							<div className="flex flex-1 flex-col p-6">
								<h3 className="text-[1.125rem] font-semibold tracking-[-0.01em]">{title}</h3>
								<p className="mt-2 flex-1 text-[0.9375rem] leading-relaxed text-text-2">{text}</p>
								<p className="data mt-4 text-[0.75rem] leading-relaxed text-text-3">{publishers(lang, c)}</p>
							</div>
						</Reveal>
					);
				})}
			</ul>
			<p className="mt-8 text-[0.9375rem] text-text-2">
				{t(`Y ${rest.length} más: `, `And ${rest.length} more: `)}
				{restNames.join(", ")}.
				{lang === "en"
					? " The screens show the app in Spanish, its first language; it also runs in English."
					: null}
			</p>
		</Section>
	);
}
