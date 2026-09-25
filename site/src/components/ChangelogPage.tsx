import { anchor, type ChangeGroup, versions } from "@/lib/catalog";
import { blob, day, type Lang, num, PATHS, REPO, tr } from "@/lib/i18n";
import { Md } from "@/lib/markdown";
import { Download } from "./Icons";

const TARGET: Readonly<Record<string, { es: string; en: string }>> = {
	"windows-x64": { es: "Windows", en: "Windows" },
	"darwin-arm64": { es: "macOS (Apple)", en: "macOS (Apple)" },
	"darwin-x64": { es: "macOS (Intel)", en: "macOS (Intel)" },
	"linux-x64": { es: "Linux x64", en: "Linux x64" },
	"linux-arm64": { es: "Linux ARM64", en: "Linux ARM64" },
};

export function kindLabel(lang: Lang, g: ChangeGroup): string {
	const t = tr(lang);
	switch (g.kind) {
		case "added":
			return t("Añadido", "Added");
		case "changed":
			return t("Cambiado", "Changed");
		case "fixed":
			return t("Arreglado", "Fixed");
		case "removed":
			return t("Quitado", "Removed");
		case "deprecated":
			return t("En desuso", "Deprecated");
		case "security":
			return t("Seguridad", "Security");
		case "known limits":
			return t("Límites conocidos", "Known limits");
		default:
			return g.title;
	}
}

/** A one-line summary: the topics of the version's notes, the first four and how many more. */
function summary(lang: Lang, topics: string[]): string {
	const t = tr(lang);
	const head = topics.slice(0, 4).join(" · ");
	const more = topics.length - 4;
	return more > 0 ? `${head} ${t(`y ${num(lang, more)} más`, `and ${num(lang, more)} more`)}` : head;
}

/** /cambios: every version, newest first, from CHANGELOG.md and the release notes (scripts/site/changelog.ts). */
export function ChangelogPage({ lang }: { lang: Lang }) {
	const t = tr(lang);
	const latest = versions[0];
	const oldest = versions.at(-1)?.version;
	return (
		<>
			<section className="relative isolate overflow-hidden pb-10 pt-32 sm:pt-36" aria-labelledby="page-title">
				<div className="graticule absolute inset-0 -z-10 [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,black,transparent)]" />
				<div className="wrap">
					<p className="eyebrow">{t("Novedades", "Changelog")}</p>
					<h1 id="page-title" className="h-display mt-5 max-w-3xl text-[clamp(2.5rem,1.4rem+3.8vw,4.25rem)]">
						{t("Qué cambió en Vigía.", "What changed in Vigía.")}
					</h1>
					<p className="lede mt-6 max-w-2xl">
						{t(
							"Cada versión, de la más nueva a la primera: lo principal en palabras simples y el registro completo. Sale de CHANGELOG.md y de las notas de cada versión.",
							"Every version, newest first: the highlights in plain words and the full record. It comes from CHANGELOG.md and each version's release notes.",
						)}
					</p>
					<div className="mt-8 flex flex-wrap items-center gap-3">
						{latest ? (
							<a
								href={`${REPO}/releases/latest`}
								className="btn btn-primary"
								target="_blank"
								rel="noopener noreferrer"
							>
								<Download />
								{t(`Descargar ${latest.version}`, `Download ${latest.version}`)}
							</a>
						) : null}
						<a href={PATHS.feed[lang]} className="btn btn-ghost">
							<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
								<path
									d="M2.5 2.5a11 11 0 0 1 11 11M2.5 7a6.5 6.5 0 0 1 6.5 6.5"
									stroke="currentColor"
									strokeWidth="1.8"
									strokeLinecap="round"
								/>
								<circle cx="3.25" cy="12.75" r="1.5" fill="currentColor" />
							</svg>
							{t("Suscribirse (RSS)", "Subscribe (RSS)")}
						</a>
					</div>
				</div>
			</section>

			<section className="pb-24" aria-label={t("Versiones", "Versions")}>
				<ol className="wrap timeline">
					{versions.map((v, i) => {
						const id = anchor(v.version);
						const topics = v.topics[lang];
						return (
							<li key={v.version} id={id} className="release scroll-mt-24">
								<div className="release__rail">
									<p className="flex flex-wrap items-center gap-2">
										<a href={`#${id}`} className="release__version data">
											{v.version}
										</a>
										{i === 0 ? <span className="badge">{t("Actual", "Latest")}</span> : null}
									</p>
									<p className="data mt-1 text-[0.8125rem] text-text-3">
										<time dateTime={v.date}>{day(lang, v.date)}</time>
									</p>
								</div>
								<article className="release__body" aria-labelledby={`${id}-title`}>
									<h2
										id={`${id}-title`}
										className="text-[1.375rem] font-semibold leading-snug tracking-[-0.015em]"
									>
										{v.version === oldest ? `${t("Primera versión pública", "First public release")}. ` : ""}
										{summary(lang, topics)}
									</h2>
									<ul className="release__list mt-5">
										{v.highlights[lang].map((h, _, all) => (
											<li key={h}>
												{/* One topic is already the heading: its bullet drops the repeated lead-in. */}
												<Md>{all.length === 1 ? h.replace(/^\*\*[^*]+\*\*\s*/, "") : h}</Md>
											</li>
										))}
									</ul>
									<details className="release__log mt-6">
										<summary>
											<span className="font-medium text-text">
												{t("Registro completo", "Full changelog")}
											</span>
											{lang === "es" ? <span className="text-text-3"> (en inglés)</span> : null}
											<span className="ml-auto flex flex-wrap gap-1.5">
												{v.groups.map((g) => (
													<span key={g.title} className={`kind kind--${g.kind.replace(/\s+/g, "-")}`}>
														{kindLabel(lang, g)} {num(lang, g.items.length)}
													</span>
												))}
											</span>
										</summary>
										<div lang="en" className="mt-4 space-y-5">
											{v.groups.map((g) => (
												<div key={g.title}>
													<h3 className="text-[0.9375rem] font-semibold">{g.title}</h3>
													<ul className="release__list release__list--small mt-2">
														{g.items.map((item) => (
															<li key={item}>
																<Md>{item}</Md>
															</li>
														))}
													</ul>
												</div>
											))}
										</div>
									</details>
									<div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3 text-[0.875rem]">
										<a
											className="link"
											href={`${REPO}/releases/tag/v${v.version}`}
											target="_blank"
											rel="noopener noreferrer"
										>
											{t("Versión en GitHub", "Release on GitHub")}
										</a>
										{v.notes ? (
											<a className="link" href={blob(v.notes)} target="_blank" rel="noopener noreferrer">
												{t("Notas completas", "Full notes")}
											</a>
										) : null}
									</div>
									{v.downloads.length > 0 ? (
										<div className="mt-4">
											<p className="sr-only">{t("Descargas", "Downloads")}</p>
											<ul className="flex flex-wrap gap-2">
												{v.downloads.map((d) => (
													<li key={d.file}>
														<a
															className="pill"
															href={`${REPO}/releases/download/v${v.version}/${d.file}`}
															title={d.file}
														>
															<Download size={13} />
															{TARGET[d.target]?.[lang] ?? d.target}
															<span className="data text-text-3">{num(lang, d.mb)} MB</span>
														</a>
													</li>
												))}
											</ul>
										</div>
									) : null}
								</article>
							</li>
						);
					})}
				</ol>
			</section>
		</>
	);
}
