import { blob, type Lang, REPO, tr } from "@/lib/i18n";
import { Mark, Wordmark } from "./Brand";
import { Download, GitHubIcon } from "./Icons";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

export function Licence({ lang }: { lang: Lang }) {
	const t = tr(lang);
	const may = [
		t("Usarlo, leerlo, modificarlo y compartirlo, gratis.", "Use it, read it, modify it and share it, free."),
		t(
			"Para estudio personal, investigación y proyectos propios, y para organizaciones benéficas, escuelas, investigación pública, salud y seguridad pública, e instituciones de gobierno.",
			"For personal study, research and hobby projects, and for charities, schools, public research, public health and safety organisations, and government institutions.",
		),
	];
	const mayNot = [
		t("Venderlo, ni vender acceso a él.", "Sell it, or sell access to it."),
		t(
			"Usarlo en un producto o servicio de pago. Eso requiere una licencia aparte.",
			"Use it in a paid product or service. That needs a separate licence.",
		),
	];
	return (
		<Section
			id="licencia"
			index="07"
			eyebrow={t("Licencia", "Licence")}
			title={t(
				"Código disponible, para todo uso no comercial.",
				"Source-available, for any non-commercial use.",
			)}
			lede={t(
				"Vigía se publica bajo la PolyForm Noncommercial License 1.0.0. En palabras simples:",
				"Vigía is published under the PolyForm Noncommercial License 1.0.0. In plain words:",
			)}
		>
			<Reveal className="mt-12 grid gap-4 md:grid-cols-2">
				<div className="card p-7">
					<h3 className="flex items-center gap-2.5 text-[1.0625rem] font-semibold">
						<span
							className="grid h-6 w-6 place-items-center rounded-full bg-ok/15 text-ok"
							aria-hidden="true"
						>
							<svg
								width="12"
								height="12"
								viewBox="0 0 12 12"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.8"
								aria-hidden="true"
							>
								<path d="M2.5 6.5 5 9l4.5-6" strokeLinecap="round" strokeLinejoin="round" />
							</svg>
						</span>
						{t("Puedes", "You may")}
					</h3>
					<ul className="mt-4 space-y-2.5 text-[0.9375rem] text-text-2">
						{may.map((s) => (
							<li key={s}>{s}</li>
						))}
					</ul>
				</div>
				<div className="card p-7">
					<h3 className="flex items-center gap-2.5 text-[1.0625rem] font-semibold">
						<span
							className="grid h-6 w-6 place-items-center rounded-full bg-alert/15 text-alert"
							aria-hidden="true"
						>
							<svg
								width="12"
								height="12"
								viewBox="0 0 12 12"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.8"
								aria-hidden="true"
							>
								<path d="M3 3l6 6M9 3 3 9" strokeLinecap="round" />
							</svg>
						</span>
						{t("No puedes", "You may not")}
					</h3>
					<ul className="mt-4 space-y-2.5 text-[0.9375rem] text-text-2">
						{mayNot.map((s) => (
							<li key={s}>{s}</li>
						))}
					</ul>
				</div>
			</Reveal>
			<p className="mt-6 max-w-3xl text-[0.875rem] leading-relaxed text-text-3">
				{t(
					"Si lo compartes, incluye la licencia y su aviso. Este resumen no es la licencia: ",
					"If you share it, pass on the licence and its notice. This summary is not the licence: ",
				)}
				<a className="link" href={blob("LICENSE")} target="_blank" rel="noopener noreferrer">
					LICENSE
				</a>
				{t(
					" lo es. Los datos pertenecen a quienes los publican, bajo sus propias licencias, que Vigía muestra junto a cada cifra.",
					" is. Data belongs to its publishers under their own licences, which Vigía shows beside every figure.",
				)}
			</p>
		</Section>
	);
}

export function FinalCta({ lang }: { lang: Lang }) {
	const t = tr(lang);
	return (
		<section className="relative overflow-hidden border-y border-line" aria-labelledby="cta-title">
			<div className="graticule absolute inset-0 -z-10 [mask-image:radial-gradient(ellipse_60%_80%_at_50%_100%,black,transparent)]" />
			<div className="wrap flex flex-col items-center py-24 text-center sm:py-28">
				<Mark size={56} intro={false} />
				<h2 id="cta-title" className="h-section mt-7 max-w-2xl">
					{t("Mira el país con tus propios ojos.", "See the country for yourself.")}
				</h2>
				<p className="lede mt-5 max-w-xl">
					{t(
						"Descárgalo, ábrelo y en dos minutos tienes la sala de situación en tu pantalla. Sin cuenta, sin claves, sin rastreo.",
						"Download it, open it, and within two minutes the situation room is on your screen. No account, no keys, no tracking.",
					)}
				</p>
				<div className="mt-9 flex flex-wrap justify-center gap-3">
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
				</div>
			</div>
		</section>
	);
}

export function Footer({ lang }: { lang: Lang }) {
	const t = tr(lang);
	const cols = [
		{
			title: t("Proyecto", "Project"),
			links: [
				[REPO, "GitHub"],
				[`${REPO}/releases`, t("Versiones", "Releases")],
				[blob("CHANGELOG.md"), t("Cambios", "Changelog")],
				[blob("CONTRIBUTING.md"), t("Contribuir", "Contributing")],
			],
		},
		{
			title: t("Datos", "Data"),
			links: [
				[blob("docs/DATA-SOURCES.md"), t("Todas las fuentes", "Every source")],
				[blob("docs/API.md"), "API"],
				[blob("docs/EVIDENCIA.md"), t("Archivo verificable", "Verifiable archive")],
			],
		},
		{
			title: t("Confianza", "Trust"),
			links: [
				[blob("docs/ETHICS.md"), t("Ética", "Ethics")],
				[blob("SECURITY.md"), t("Seguridad", "Security")],
				[blob("LICENSE"), t("Licencia", "Licence")],
				[blob("NOTICE"), t("Avisos de terceros", "Third-party notices")],
			],
		},
	] as const;
	return (
		<footer className="pb-12 pt-16">
			<div className="wrap">
				<div className="grid gap-12 md:grid-cols-[minmax(0,1.3fr)_repeat(3,minmax(0,1fr))]">
					<div>
						<div className="flex items-center gap-2.5">
							<Mark size={26} intro={false} />
							<Wordmark height={13} />
						</div>
						<p className="mt-4 max-w-xs text-[0.875rem] leading-relaxed text-text-3">
							{t(
								"Sala de situación abierta de Venezuela. Cada cifra con su fuente y su hora.",
								"An open situation room for Venezuela. Every figure with its source and its time.",
							)}
						</p>
					</div>
					{cols.map((c) => (
						<nav key={c.title} aria-label={c.title}>
							<h2 className="text-[0.8125rem] font-semibold text-text">{c.title}</h2>
							<ul className="mt-4 space-y-2.5">
								{c.links.map(([href, label]) => (
									<li key={href}>
										<a
											href={href}
											className="text-[0.875rem] text-text-3 transition-colors hover:text-text"
											target="_blank"
											rel="noopener noreferrer"
										>
											{label}
										</a>
									</li>
								))}
							</ul>
						</nav>
					))}
				</div>
				<div className="mt-14 flex flex-col gap-3 border-t border-line pt-6 text-[0.8125rem] text-text-3 sm:flex-row sm:items-center sm:justify-between">
					<p>
						{t("Hecho por ", "Made by ")}
						<a
							className="link"
							href="https://github.com/elberacasa"
							target="_blank"
							rel="noopener noreferrer"
						>
							elberacasa
						</a>
						{t(
							". Sin analítica, sin cookies: esta página no hace ninguna solicitud a terceros.",
							". No analytics, no cookies: this page makes no requests to third parties.",
						)}
					</p>
					<p className="data">PolyForm Noncommercial 1.0.0</p>
				</div>
			</div>
		</footer>
	);
}
