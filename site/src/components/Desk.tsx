import Image from "next/image";
import { facts } from "@/lib/data";
import { type Lang, num, tr } from "@/lib/i18n";
import { media } from "@/lib/media";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

/**
 * The 1.0 desk: its modules (web/src/lib/modules.ts, through facts.json), the entity pages (the ontology's counts)
 * and three stills of the running app (scripts/site-capture.ts). Every number is computed from the code.
 */
export function Desk({ lang }: { lang: Lang }) {
	const t = tr(lang);
	const p = facts.places.byType;
	const features = [
		{
			title: t("Incidentes con la regla a la vista", "Incidents with the rule in sight"),
			text: t(
				"Un incidente se abre solo cuando familias de fuentes independientes coinciden en el mismo lugar y momento. La prensa sola no basta. Nunca una probabilidad.",
				"An incident opens only when independent families of sources agree on the same place and time. The press alone is not enough. Never a probability.",
			),
		},
		{
			title: t("Lo inusual, por reglas fijas", "What is unusual, by fixed rules"),
			text: t(
				"Cada serie se compara con su propia historia; los umbrales están escritos en código y se muestran junto a la lectura.",
				"Each series is compared with its own history; the thresholds are written in code and shown next to the reading.",
			),
		},
		{
			title: t("«¿Tienes luz?»", "“Do you have power?”"),
			text: t(
				"Reportes anónimos de luz, agua, internet y gasolina por municipio, sin cuenta. Se cuentan; nunca se publican uno a uno.",
				"Anonymous power, water, internet and fuel reports by municipality, with no account. They are counted; never published one by one.",
			),
		},
		{
			title: t("Sin IA por defecto", "No AI by default"),
			text: t(
				"Todo lo que ves lo calcula código probado. Jev y Claude son mejoras opcionales, con tu clave y un presupuesto que tú fijas.",
				"Everything you see is computed by tested code. Jev and Claude are optional upgrades, with your key and a budget you set.",
			),
		},
	];
	return (
		<Section
			id="mesa"
			index="02"
			eyebrow={t("Nuevo en 1.0", "New in 1.0")}
			title={t("Una mesa de trabajo, no un tablero.", "A workstation, not a dashboard.")}
			lede={t(
				`${num(lang, facts.modules.length)} módulos a una tecla, un inspector que explica cualquier lugar y un registro de eventos que no se detiene. Cada estado, municipio, parroquia e instalación tiene su ficha.`,
				`${num(lang, facts.modules.length)} modules one key away, an inspector that explains any place, and an event log that never stops. Every state, municipality, parish and facility has its own page.`,
			)}
		>
			<div className="mt-14 grid gap-5 lg:grid-cols-12">
				<Reveal className="lg:col-span-8">
					<figure className="flex h-full flex-col">
						<div className="frame">
							<Image
								src={media("still-ficha.webp")}
								alt={t(
									"La ficha del estado Zulia en Vigía: censo y estimación de población, superficie y capital, las señales de ahora con su fuente, su base y su edad, y el mapa del estado con sus instalaciones.",
									"Zulia state's page in Vigía: census and population estimate, area and capital, the current signals with their source, basis and age, and the state's map with its facilities.",
								)}
								width={1920}
								height={1200}
								sizes="(min-width: 1216px) 760px, (min-width: 1024px) 64vw, 100vw"
								className="h-auto w-full"
							/>
						</div>
						<figcaption className="mt-4 max-w-2xl text-[0.9375rem] leading-relaxed text-text-2">
							<span className="font-semibold text-text">
								{t(`${num(lang, facts.places.total)} fichas.`, `${num(lang, facts.places.total)} pages.`)}
							</span>{" "}
							{t(
								`${num(lang, p.state)} estados, ${num(lang, p.municipality)} municipios, ${num(lang, p.parish)} parroquias y ${num(lang, p.infrastructure)} instalaciones (hospitales, subestaciones, centrales, represas, aeropuertos, refinerías, puertos), además de ${num(lang, p.outlet)} medios, ${num(lang, p.institution)} instituciones y ${num(lang, p.network)} redes. Cada ficha junta las señales de ese lugar, cada una con su fuente, su base y su edad.`,
								`${num(lang, p.state)} states, ${num(lang, p.municipality)} municipalities, ${num(lang, p.parish)} parishes and ${num(lang, p.infrastructure)} facilities (hospitals, substations, power plants, dams, airports, refineries, ports), plus ${num(lang, p.outlet)} outlets, ${num(lang, p.institution)} institutions and ${num(lang, p.network)} networks. Each page gathers that place's signals, each with its source, basis and age.`,
							)}
						</figcaption>
					</figure>
				</Reveal>

				<Reveal delay={0.06} className="lg:col-span-4">
					<div className="card flex h-full flex-col p-6 sm:p-7">
						<h3 className="text-[1.0625rem] font-semibold tracking-[-0.01em]">
							{t("Una tecla por módulo", "One key per module")}
						</h3>
						<p className="mt-1.5 text-[0.875rem] leading-relaxed text-text-3">
							{t(
								"Cada módulo responde una pregunta. / busca, P abre la ficha, I el inspector.",
								"Each module answers one question. / searches, P opens the page, I the inspector.",
							)}
						</p>
						<ol className="mt-5 flex-1 divide-y divide-line border-y border-line">
							{facts.modules.map((m) => (
								<li key={m.id} className="flex items-start gap-3.5 py-2.5">
									<kbd className="kbd mt-px">{m.key}</kbd>
									<span className="min-w-0">
										<span className="block text-[0.9375rem] font-medium leading-snug">
											{lang === "es" ? m.es : m.en}
										</span>
										<span className="block text-[0.8125rem] leading-snug text-text-3">
											{lang === "es" ? m.qEs : m.qEn}
										</span>
									</span>
								</li>
							))}
						</ol>
					</div>
				</Reveal>

				<Reveal className="lg:col-span-6">
					<figure>
						<div className="frame">
							<Image
								src={media("still-envivo.webp")}
								alt={t(
									"El módulo En vivo: canales de TV con un cuadro fechado de cada uno y cámaras públicas con su última imagen.",
									"The Live module: TV channels with a dated frame from each, and public cameras with their latest still.",
								)}
								width={1920}
								height={1200}
								sizes="(min-width: 1216px) 570px, (min-width: 1024px) 48vw, 100vw"
								className="h-auto w-full"
							/>
						</div>
						<figcaption className="mt-4 text-[0.9375rem] leading-relaxed text-text-2">
							<span className="font-semibold text-text">{t("En vivo.", "Live.")}</span>{" "}
							{t(
								"Vigía comprueba si cada canal y emisora transmite, y toma un cuadro fechado de los canales y cámaras públicas que lo permiten. Una señal caída nunca parece viva.",
								"Vigía checks whether each channel and station is on air, and takes a dated frame from the channels and public cameras that allow it. A dead signal never looks live.",
							)}
						</figcaption>
					</figure>
				</Reveal>
				<Reveal delay={0.06} className="lg:col-span-6">
					<figure>
						<div className="frame">
							<Image
								src={media("still-internet.webp")}
								alt={t(
									"El módulo Internet: caídas de señal por estado frente a lo normal a esa hora, censura por operadora y rutas de red.",
									"The Internet module: signal drops by state against what is normal at that hour, censorship by ISP, and network routes.",
								)}
								width={1920}
								height={1200}
								sizes="(min-width: 1216px) 570px, (min-width: 1024px) 48vw, 100vw"
								className="h-auto w-full"
							/>
						</div>
						<figcaption className="mt-4 text-[0.9375rem] leading-relaxed text-text-2">
							<span className="font-semibold text-text">{t("Internet.", "Internet.")}</span>{" "}
							{t(
								"Caídas por estado frente a lo normal a esa hora, bloqueos por operadora y rutas de red, lado a lado y cada uno con su fuente.",
								"Drops by state against what is normal at that hour, blocks by ISP and network routes, side by side and each with its source.",
							)}
						</figcaption>
					</figure>
				</Reveal>
			</div>

			<ul className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
				{features.map((f, i) => (
					<Reveal as="li" key={f.title} delay={(i % 4) * 0.05} className="bg-bg p-6 sm:p-7">
						<h3 className="text-[1rem] font-semibold tracking-[-0.01em]">{f.title}</h3>
						<p className="mt-2 text-[0.875rem] leading-relaxed text-text-2">{f.text}</p>
					</Reveal>
				))}
			</ul>
		</Section>
	);
}
