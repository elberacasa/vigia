import { useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { panels } from "../lib/data.ts";
import { int, num, stamp } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import panelsCss from "../styles/panels.css?inline";
import { Panel } from "../ui/Panel.tsx";
import { SourceTag } from "../ui/Source.tsx";

addStyles(panelsCss);

/** Mirrors src/panels/censorship.ts: OONI and VE sin Filtro side by side, never blended. */
interface SiteRow {
	key: string;
	name: string;
	categoryLabel: string;
	agreement: "both" | "vsf-only" | "ooni-only";
	vsf: { blockedOn: string[]; methods: string[]; active: boolean } | null;
	ooni: { flaggedOn: string[]; anomalyRatePct: number; measurements: number; url: string } | null;
}
interface IspRow {
	isp: string;
	name: string;
	ooni: { flagged: number; tested: number } | null;
	vsf: { blocked: number } | null;
}
interface BlockChange {
	source: "vesinfiltro" | "ooni";
	kind: "blocked" | "unblocked" | "flagged" | "unflagged";
	domain: string;
	isp: string;
	after: number;
	by: number;
	methods: string[];
	url: string;
}
interface BlockTimeline {
	changes: BlockChange[];
	watchingSince: { vesinfiltro: number | null; ooni: number | null };
	noteEs: string;
	noteEn: string;
}

const CHANGE_LABEL: Record<BlockChange["kind"], { es: string; en: string }> = {
	blocked: { es: "Bloqueado", en: "Blocked" },
	unblocked: { es: "Desbloqueado", en: "Unblocked" },
	flagged: { es: "Posible bloqueo (OONI)", en: "Possible block (OONI)" },
	unflagged: { es: "OONI ya no lo marca", en: "No longer flagged (OONI)" },
};

function Timeline({ tl, ispName }: { tl: BlockTimeline; ispName: (id: string) => string }) {
	const l = lang.value;
	const since = [tl.watchingSince.vesinfiltro, tl.watchingSince.ooni].filter((x): x is number => x !== null);
	return (
		<div class="timeline">
			<h3 class="caps state-block__title">{t("Cambios recientes, 30 días", "Recent changes, 30 days")}</h3>
			{tl.changes.length ? (
				<ul class="timeline__list">
					{tl.changes.slice(0, 12).map((c) => (
						<li key={`${c.source}-${c.kind}-${c.domain}-${c.isp}-${c.by}`} class={`change change--${c.kind}`}>
							<span class="change__kind">{CHANGE_LABEL[c.kind][l]}</span>
							<a href={c.url} target="_blank" rel="noopener noreferrer" class="change__domain">
								{c.domain}
							</a>
							<span class="note">
								{ispName(c.isp)} · {t("entre", "between")} {stamp(c.after, l)} {t("y", "and")}{" "}
								{stamp(c.by, l)}
								{c.methods.length ? ` · ${c.methods.join(" + ")}` : ""}
							</span>
						</li>
					))}
				</ul>
			) : (
				<p class="note">
					{since.length
						? t(
								`Sin cambios desde que Vigía empezó a observar (${stamp(Math.min(...since), l)}).`,
								`No changes since Vigía started watching (${stamp(Math.min(...since), l)}).`,
							)
						: t("Aún sin historia.", "No history yet.")}
				</p>
			)}
			<p class="note">{l === "es" ? tl.noteEs : tl.noteEn}</p>
		</div>
	);
}

export interface CensorshipView {
	timeline: BlockTimeline;
	ooni: {
		observedAt: number;
		measurements: number;
		domainsFlagged: number;
		rule: string;
		feed: string;
		sourceUrl: string;
	} | null;
	vsf: { updated: string; observedAt: number; sitesBlocked: number; feed: string; sourceUrl: string } | null;
	agreement: { both: number; vsfOnly: number; ooniOnly: number };
	byCategory: { code: string; label: string; ooni: number; vsf: number }[];
	byIsp: IspRow[];
	sites: SiteRow[];
	notes: string[];
}

export function CensorshipPanel() {
	const view = panels.value.censorship as CensorshipView | undefined;
	const [all, setAll] = useState(false);
	const l = lang.value;
	return (
		<Panel
			id="censura"
			title={PANEL_META.censura.title()}
			question={PANEL_META.censura.question()}
			feeds={PANEL_META.censura.feeds()}
			foot={view ? view.notes.map((n) => <span key={n}>{n}</span>) : null}
		>
			{!view ? (
				<p class="skeleton">…</p>
			) : (
				<>
					<div class="stat-row">
						<div class="figure">
							<span class="figure__label">VE sin Filtro</span>
							<span class="figure__value">{int(view.vsf?.sitesBlocked ?? 0, l)}</span>
							<span class="note">{t("sitios bloqueados", "blocked sites")}</span>
						</div>
						<div class="figure">
							<span class="figure__label">OONI, 7 d</span>
							<span class="figure__value">{int(view.ooni?.domainsFlagged ?? 0, l)}</span>
							<span class="note">{t("posibles bloqueos", "possible blocks")}</span>
						</div>
						<div class="figure">
							<span class="figure__label">{t("Coinciden", "Both agree")}</span>
							<span class="figure__value">{int(view.agreement.both, l)}</span>
						</div>
					</div>
					<ul class="isp-grid">
						{view.byIsp.map((i) => (
							<li key={i.isp}>
								<span class="isp-grid__name">{i.name}</span>
								<span class="data">{i.vsf ? int(i.vsf.blocked, l) : "—"}</span>
								<span class="data note">{i.ooni ? int(i.ooni.flagged, l) : "—"}</span>
							</li>
						))}
					</ul>
					<p class="note isp-grid__legend">
						{t(
							"Por operadora: VE sin Filtro (bloqueados) · OONI (posibles)",
							"By ISP: VE sin Filtro (blocked) · OONI (possible)",
						)}
					</p>
					<ul class="sites">
						{view.sites.slice(0, all ? 60 : 8).map((s) => (
							<li key={s.key}>
								<span class="sites__name">{s.name}</span>
								<span class="tag">{s.categoryLabel}</span>
								<span class={`agree agree--${s.agreement}`}>
									{s.agreement === "both"
										? t("ambas fuentes", "both sources")
										: s.agreement === "vsf-only"
											? "VE sin Filtro"
											: `OONI ${num(s.ooni?.anomalyRatePct ?? 0, 0, l)} %`}
								</span>
							</li>
						))}
					</ul>
					{view.sites.length > 8 ? (
						<button type="button" class="link-button" onClick={() => setAll(!all)}>
							{all
								? t("Ver menos", "Show fewer")
								: t(
										`Ver ${Math.min(60, view.sites.length)} sitios`,
										`Show ${Math.min(60, view.sites.length)} sites`,
									)}
						</button>
					) : null}
					<Timeline tl={view.timeline} ispName={(id) => view.byIsp.find((i) => i.isp === id)?.name ?? id} />
					<div class="sources-row">
						{view.vsf ? (
							<SourceTag
								source={{ feed: view.vsf.feed, observedAt: view.vsf.observedAt, url: view.vsf.sourceUrl }}
								label="VE sin Filtro"
							/>
						) : null}
						{view.ooni ? (
							<SourceTag
								source={{
									feed: view.ooni.feed,
									observedAt: view.ooni.observedAt,
									url: view.ooni.sourceUrl,
									detail: view.ooni.rule,
								}}
								label="OONI"
							/>
						) : null}
					</div>
				</>
			)}
		</Panel>
	);
}
