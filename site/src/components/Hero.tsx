import { preload } from "react-dom";
import map from "@/data/map.json";
import { facts } from "@/lib/data";
import { type Lang, num, REPO, tr, when } from "@/lib/i18n";
import { media } from "@/lib/media";
import { HeroMap, type Stills } from "./HeroMap";
import { Arrow, Download, GitHubIcon } from "./Icons";

/** The hero map's still, 640/960/1280 px wide in each theme (scripts/site-capture.ts, "mapstill"). */
function stills(): Stills {
	const set = (theme: "dark" | "light") =>
		[640, 960, 1280].map((w) => `${media(`map-still-${theme}-${w}.webp`)} ${w}w`).join(", ");
	return {
		dark: { src: media("map-still-dark-1280.webp"), srcSet: set("dark") },
		light: { srcSet: set("light") },
		sizes: "(min-width: 1024px) 54vw, 100vw",
	};
}

export function Hero({ lang }: { lang: Lang }) {
	const t = tr(lang);
	// The largest paint: preloaded at high priority, the right width for the screen, in the system's theme.
	const still = stills();
	for (const [theme, srcSet] of [
		["dark", still.dark.srcSet],
		["light", still.light.srcSet],
	] as const) {
		preload(media(`map-still-${theme}-1280.webp`), {
			as: "image",
			imageSrcSet: srcSet,
			imageSizes: still.sizes,
			fetchPriority: "high",
			media: `(prefers-color-scheme: ${theme})`,
		});
	}
	const live = map.live;
	const normal = live.connectivity.states.filter((s) => s.level === "normal").length;
	const dropped = live.connectivity.states.filter((s) => s.level === "drop" || s.level === "severe").length;
	const withData = live.connectivity.states.filter((s) => s.level !== "no-data").length;
	const strongest = live.quakes.reduce((m, q) => Math.max(m, q.mag), 0);
	const sizes = facts.release.map((r) => r.mb);
	return (
		<section className="relative isolate overflow-hidden pt-28 sm:pt-32" aria-labelledby="hero-title">
			<div className="hero-grid graticule absolute inset-0 -z-20 [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,black,transparent)]" />
			<div
				className="hero-glow pointer-events-none absolute right-[-10%] top-24 -z-10 h-[40rem] w-[52rem] rounded-full [background:radial-gradient(closest-side,var(--glow),transparent)]"
				aria-hidden="true"
			/>
			<div className="wrap grid items-center gap-10 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:gap-8">
				<div className="relative z-10 max-w-[36rem]">
					<p className="chip mb-7">
						<span className="data text-text">v{facts.version}</span>
						<span className="h-3 w-px bg-line-strong" aria-hidden="true" />
						{t("Gratis · sin cuenta · en tu equipo", "Free · no account · on your machine")}
					</p>
					<h1 id="hero-title" className="h-display text-[clamp(2.625rem,1.2rem+4.4vw,4rem)]">
						{t("Venezuela, ahora.", "Venezuela, now.")}
						<span className="mt-2 block text-text-3">
							{t("Cada cifra con su fuente y su hora.", "Every figure with its source and its time.")}
						</span>
					</h1>
					<p className="lede mt-7 max-w-[34rem]">
						{t(
							`Vigía reúne en una pantalla lo que pasa en el país: el dólar oficial y el paralelo, internet por estado, censura, sismos, incendios, clima y las noticias de ${num(lang, facts.newsPublishers)} medios. Corre en tu computadora, sin cuenta y sin claves.`,
							`Vigía puts what is happening in the country on one screen: the official and parallel dollar, internet by state, censorship, earthquakes, fires, weather and the news from ${num(lang, facts.newsPublishers)} publishers. It runs on your own computer, with no account and no keys.`,
						)}
					</p>
					<div className="mt-9 flex flex-wrap items-center gap-3">
						<a
							href={`${REPO}/releases/latest`}
							className="btn btn-primary"
							target="_blank"
							rel="noopener noreferrer"
						>
							<Download />
							{t("Descargar", "Download")}
						</a>
						<a href={REPO} className="btn btn-ghost" target="_blank" rel="noopener noreferrer">
							<GitHubIcon />
							{t("Ver en GitHub", "View on GitHub")}
						</a>
						<a
							href="#como-funciona"
							className="group inline-flex h-11 items-center gap-1.5 px-2 text-[0.9375rem] font-medium text-text-2 transition-colors hover:text-text"
						>
							{t("Cómo funciona", "How it works")}
							<span className="transition-transform group-hover:translate-y-0.5">
								<Arrow down />
							</span>
						</a>
					</div>
					<p className="mt-6 text-[0.8125rem] text-text-3">
						{t(
							`Linux, Windows y macOS (estos dos, nuevos) · ${num(lang, Math.min(...sizes))}–${num(lang, Math.max(...sizes))} MB · código disponible bajo licencia no comercial`,
							`Linux, Windows and macOS (the last two are new) · ${num(lang, Math.min(...sizes))}–${num(lang, Math.max(...sizes))} MB · source-available under a non-commercial licence`,
						)}
					</p>
				</div>

				<figure className="relative -mx-4 sm:mx-0">
					<div className="relative aspect-[16/13] w-full">
						<HeroMap
							lang={lang}
							stills={still}
							alt={t(
								`Mapa de Venezuela por estados, con ${live.quakes.length} sismos de la última semana y los ${live.fires.length} focos de calor más intensos del día.`,
								`Map of Venezuela by state, with ${live.quakes.length} earthquakes from the past week and the day's ${live.fires.length} strongest heat detections.`,
							)}
						/>
					</div>
					<figcaption className="relative z-10 mx-4 -mt-2 sm:mx-0">
						<ul className="flex flex-wrap gap-x-5 gap-y-2 text-[0.8125rem] text-text-2">
							<li className="flex items-center gap-2">
								<span
									className="inline-block h-3 w-3 rounded-full border-2 border-signal"
									aria-hidden="true"
								/>
								{t(
									`${live.quakes.length} sismos en 7 días, el mayor M${num(lang, strongest, 1)}`,
									`${live.quakes.length} earthquakes in 7 days, largest M${num(lang, strongest, 1)}`,
								)}
								<span className="text-text-3">USGS · FUNVISIS</span>
							</li>
							<li className="flex items-center gap-2">
								<span className="inline-block h-2 w-2 rounded-full bg-warn" aria-hidden="true" />
								{t(
									`${live.fires.length} focos más intensos, 24 h`,
									`${live.fires.length} strongest fires, 24 h`,
								)}
								<span className="text-text-3">NASA FIRMS</span>
							</li>
							<li className="flex items-center gap-2">
								<span
									className="inline-block h-2.5 w-3.5 rounded-[3px] border border-line-strong bg-surface-3"
									aria-hidden="true"
								/>
								{dropped === 0
									? normal === withData
										? t(
												`Internet normal en los ${withData} estados con datos`,
												`Internet normal in all ${withData} states with data`,
											)
										: t(
												`Internet normal en ${normal} de los ${withData} estados con datos`,
												`Internet normal in ${normal} of the ${withData} states with data`,
											)
									: t(
											`Internet: caída en ${dropped} de los ${withData} estados con datos`,
											`Internet: drops in ${dropped} of the ${withData} states with data`,
										)}
								<span className="text-text-3">IODA</span>
							</li>
						</ul>
						<p className="data mt-3 text-[0.75rem] text-text-3">
							{t(
								`Instantánea de Vigía al ${when(lang, live.asOf)} (hora de Caracas), tomada al preparar esta versión del sitio. No es en vivo: para eso, corre Vigía.`,
								`A snapshot from Vigía as of ${when(lang, live.asOf)} (Caracas time), taken when this version of the site was prepared. Not live: for that, run Vigía.`,
							)}
						</p>
					</figcaption>
				</figure>
			</div>
		</section>
	);
}
