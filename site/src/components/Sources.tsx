import { Fragment } from "react";
import { sources } from "@/lib/catalog";
import { facts } from "@/lib/data";
import { type Lang, num, PATHS, tr } from "@/lib/i18n";
import { AccessTag } from "./Access";
import { Count } from "./Count";
import { Arrow } from "./Icons";
import { Reveal } from "./Reveal";
import { Section } from "./Section";
import { StateMap } from "./StateMap";

const collator = new Intl.Collator("es", { sensitivity: "base" });
const NEWS = new Set(["national", "regional", "international", "video", "telegram"]);

/**
 * Publishers' names the way a reader knows them (a feed's "(YouTube)" or "(Telegram)" tag dropped), taken in turn
 * from each group so the wall shows the range, not the start of the alphabet. The wall shows a few lines of it; the
 * full list is on /fuentes.
 */
export function wallNames(limit: number): string[] {
	const byGroup = new Map<string, string[]>();
	const seen = new Set<string>();
	for (const r of [...sources.rows].sort((a, b) => collator.compare(a.name.es, b.name.es))) {
		// The broadcast probes and Vigía's own measurement are not publishers.
		if (/medido por Vigía|medición propia/.test(r.provider)) continue;
		const n = (NEWS.has(r.group) ? r.name.es : r.provider)
			.replace(/\s*\((YouTube|Telegram)\)\s*$/, "")
			.trim();
		if (seen.has(n)) continue;
		seen.add(n);
		byGroup.set(r.group, [...(byGroup.get(r.group) ?? []), n]);
	}
	const lists = [...byGroup.values()];
	const out: string[] = [];
	for (let i = 0; out.length < limit && lists.some((l) => i < l.length); i++)
		for (const l of lists) if (i < l.length && out.length < limit) out.push(l[i] as string);
	return out;
}

/** Home: how wide the net is, in four numbers, the regional map, the groups and every publisher's name. */
export function Sources({ lang }: { lang: Lang }) {
	const t = tr(lang);
	const s = sources;
	const regional = s.states.filter((x) => x.outlets > 0);
	const local = regional.reduce((n, x) => n + x.outlets, 0);
	const stats = [
		{ value: s.total, label: t("fuentes", "sources") },
		{ value: s.free, label: t("sin ninguna clave", "with no key at all") },
		{ value: s.outlets, label: t("medios de noticias", "news publishers") },
		{ value: s.countries, label: t("países de origen", "countries of origin") },
	];
	const href = PATHS.sources[lang];
	return (
		<Section
			id="fuentes"
			index="03"
			eyebrow={t("Fuentes", "Sources")}
			title={t(
				`${num(lang, s.total)} fuentes, cada una con nombre y licencia.`,
				`${num(lang, s.total)} sources, each with a name and a licence.`,
			)}
			lede={t(
				`Bancos centrales, redes de medición, satélites, organismos de la ONU y ${num(lang, s.outlets)} medios. ${num(lang, s.free)} funcionan sin clave ni cuenta; la lista sale del código de esta versión.`,
				`Central banks, measurement networks, satellites, UN agencies and ${num(lang, s.outlets)} publishers. ${num(lang, s.free)} work with no key or account; the list comes from this version's code.`,
			)}
		>
			<div className="mt-14 grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
				<Reveal className="flex flex-col gap-4">
					<dl className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line">
						{stats.map((x) => (
							<div key={x.label} className="flex flex-col bg-bg p-6 sm:p-7">
								<dt className="order-2 mt-1.5 text-[0.9375rem] text-text-2">{x.label}</dt>
								<dd className="order-1 text-[clamp(2.25rem,1.6rem+2vw,3.25rem)] font-semibold leading-none tracking-[-0.045em]">
									<Count lang={lang} value={x.value} />
								</dd>
							</div>
						))}
					</dl>
					<nav aria-label={t("Fuentes por grupo", "Sources by group")} className="card p-5 sm:p-6">
						<ul className="flex flex-wrap gap-2">
							{s.groups.map((g) => (
								<li key={g.id}>
									<a href={`${href}#${g.slug}`} className="pill">
										{g.name[lang]}
										<span className="data text-text-3">{num(lang, g.count)}</span>
									</a>
								</li>
							))}
						</ul>
						<p className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-4 text-[0.8125rem] text-text-2">
							{(["free", "key", "optin"] as const).map((a) => (
								<span key={a} className="inline-flex items-center gap-2">
									<AccessTag lang={lang} access={a} />
									<span className="data text-text-3">{num(lang, s[a])}</span>
								</span>
							))}
						</p>
					</nav>
				</Reveal>
				<Reveal delay={0.06} className="card flex flex-col p-5 sm:p-6">
					<h3 className="text-[1.0625rem] font-semibold">
						{t("Medios regionales por estado", "Regional outlets by state")}
					</h3>
					<p className="mt-1 text-[0.875rem] text-text-2">
						{t(
							`${num(lang, local)} medios (sitios y canales) en ${num(lang, regional.length)} de las ${s.states.length} entidades, además de la prensa nacional e internacional.`,
							`${num(lang, local)} outlets (sites and channels) in ${num(lang, regional.length)} of the ${s.states.length} states, besides the national and international press.`,
						)}
					</p>
					<StateMap lang={lang} className="mx-auto mt-4 max-w-[26rem]" />
					<p className="mt-auto pt-4 text-[0.8125rem] leading-relaxed text-text-3">
						{[...regional]
							.sort((a, b) => b.outlets - a.outlets)
							.slice(0, 8)
							.map((x) => (
								<span key={x.iso} className="mr-3 inline-block">
									{x.name} <span className="data text-text-2">{x.outlets}</span>
								</span>
							))}
						<a
							href={`${href}?grupo=medios-regionales#catalogo`}
							className="link inline-block whitespace-nowrap"
						>
							{t("todos los estados", "every state")}
						</a>
					</p>
				</Reveal>
			</div>
			<Reveal className="relative mt-4">
				<div className="card relative overflow-hidden px-5 pb-20 pt-6 sm:px-7">
					<p className="eyebrow">{t("Quién publica lo que ves", "Who publishes what you see")}</p>
					<p className="name-wall mt-4 max-h-[13.5rem] overflow-hidden" lang="und">
						{/* Spaces between the names are where lines may break; each name keeps its separator. */}
						{wallNames(96).map((n, i) => (
							<Fragment key={n}>
								{i > 0 ? " " : null}
								<span>{n}</span>
							</Fragment>
						))}
					</p>
					<div className="absolute inset-x-0 bottom-0 flex h-36 items-end justify-center bg-gradient-to-t from-surface-1 via-surface-1/95 to-transparent pb-6">
						<a href={href} className="btn btn-ghost group">
							{t(`Ver las ${num(lang, s.total)} fuentes`, `See all ${num(lang, s.total)} sources`)}
							<span className="transition-transform group-hover:translate-x-0.5">
								<Arrow />
							</span>
						</a>
					</div>
				</div>
			</Reveal>
			<p className="data mt-5 text-[0.75rem] text-text-3">
				{t("Del registro de adaptadores de la versión ", "From the adapter registry of version ")}
				{facts.version}
				{t("; nombres y marcas pertenecen a sus editores.", "; names and marks belong to their publishers.")}
			</p>
		</Section>
	);
}
