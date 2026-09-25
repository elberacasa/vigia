import { useState } from "preact/hooks";
import { topClusters } from "../lib/clusters.ts";
import { addStyles } from "../lib/css.ts";
import { now, panels } from "../lib/data.ts";
import { ago, clock, stamp, TZ } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import { storyAllowed } from "../lib/panelprefs.ts";
import { useFresh } from "../lib/seen.ts";
import { stateName } from "../lib/states.ts";
import { newsTopic, TOPICS, type Topic } from "../lib/topics.ts";
import { selectedState } from "../map/view.ts";
import panelsCss from "../styles/panels.css?inline";
import { MineFoot, MineTag, NewsFilterChip, NewsSourceTabs, newsViewId } from "../ui/custom/NewsMine.tsx";
import { NewPill, NewTag } from "../ui/Digits.tsx";
import { Panel } from "../ui/Panel.tsx";

addStyles(panelsCss);

export type { Topic };

const STANCE: Record<string, { es: string; en: string }> = {
	independent: { es: "independiente", en: "independent" },
	commercial: { es: "privado", en: "private" },
	state: { es: "estatal", en: "state" },
	"state-aligned": { es: "afín al gobierno", en: "government-aligned" },
	"state-funded": { es: "financiado por un Estado", en: "state-funded" },
	"public-broadcaster": { es: "servicio público", en: "public broadcaster" },
	ngo: { es: "ONG", en: "NGO" },
	partisan: { es: "partidista", en: "partisan" },
	agency: { es: "agencia", en: "agency" },
	aggregator: { es: "agregador", en: "aggregator" },
	user: { es: "añadida por ti", en: "added by you" },
	multilateral: { es: "organismo multilateral", en: "multilateral body" },
	"trade-body": { es: "gremio", en: "trade or professional body" },
};

/** Publishers that are not newsrooms say so (src/adapters/rss/factory.ts, Genre). */
const GENRE: Record<string, { es: string; en: string }> = {
	"fact-check": { es: "verificador", en: "fact-checker" },
	official: { es: "fuente oficial", en: "official source" },
	rights: { es: "monitor de DD. HH.", en: "rights monitor" },
};

interface StoryOutlet {
	id: string;
	name: string;
	stance: string;
	genre?: string;
	region: string;
	title: string;
	url: string;
	at: number;
	dateMissing: boolean;
}
export interface Story {
	id: string;
	title: string;
	url: string;
	at: number;
	firstAt: number;
	firstOutlet: string;
	outlets: StoryOutlet[];
	outletCount: number;
	topics: Topic[];
	state: string | null;
	states: string[];
	places: string[];
	video: boolean;
}
export interface NewsView {
	stories: Record<string, Story>;
	top: string[];
	latest: string[];
	byState: Record<
		string,
		{ items: number; stories: number; topics: Partial<Record<Topic, number>>; top: string[] }
	>;
	topicCounts: Partial<Record<Topic, number>>;
	items24h: number;
	outletsReporting24h: number;
	outletsTotal: number;
}

const caracasDay = new Intl.DateTimeFormat("en-CA", {
	timeZone: TZ,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

/** "14:05" today, "23 sept, 14:05" before (Caracas time). */
function when(at: number): string {
	const l = lang.value;
	return caracasDay.format(at) === caracasDay.format(now.value) ? clock(at, l) : stamp(at, l);
}

function Outlets({ story }: { story: Story }) {
	const l = lang.value;
	return (
		<ul class="story__outlets">
			{[...story.outlets]
				.sort((a, b) => a.at - b.at)
				.map((o) => (
					<li key={o.url}>
						<a href={o.url} target="_blank" rel="noopener noreferrer">
							<strong>{o.name}</strong>
							<span class="stance">
								{STANCE[o.stance]?.[l] ?? o.stance}
								{o.genre && GENRE[o.genre] ? ` · ${GENRE[o.genre]?.[l]}` : ""}
							</span>
							<span class="data note">{o.dateMissing ? t("sin fecha", "no date") : when(o.at)}</span>
							<span class="story__outlet-title">{o.title}</span>
						</a>
					</li>
				))}
		</ul>
	);
}

function Place({ story }: { story: Story }) {
	if (!story.states.length) return null;
	return (
		<span class="tag tag--place" title={t("Ubicación por palabra clave", "Location by keyword")}>
			{story.states.map((s) => stateName(s)).join(", ")}
		</span>
	);
}

/** The top of the panel: one card per heavily covered story, with a coverage meter of one block per outlet. */
function ClusterCard({
	story,
	outlets,
	hours,
	fresh,
}: {
	story: Story;
	outlets: number;
	hours: number;
	fresh: boolean;
}) {
	const [open, setOpen] = useState(false);
	const first = [...story.outlets].sort((a, b) => a.at - b.at)[0];
	const shown = Math.min(outlets, 24);
	return (
		<li class={`news-card${fresh ? " is-new" : ""}${open ? " is-open" : ""}`}>
			<a class="news-card__title" href={story.url} target="_blank" rel="noopener noreferrer">
				{fresh ? <NewTag /> : null}
				{story.video ? <span class="story__video">▶ </span> : null}
				{story.title}
			</a>
			<div class="news-card__coverage">
				<span class="coverage" aria-hidden="true">
					{Array.from({ length: shown }, (_, i) => (
						<i key={i} />
					))}
				</span>
				<span class="news-card__count">
					{t(`${outlets} medios en ${hours} h`, `${outlets} outlets in ${hours} h`)}
				</span>
			</div>
			<div class="story__meta">
				{first ? (
					<span>
						{t("primero", "first")}:{" "}
						<span class="data">{first.dateMissing ? t("sin fecha", "no date") : when(first.at)}</span>{" "}
						{first.name}
					</span>
				) : null}
				<Place story={story} />
				<button type="button" class="story__more" aria-expanded={open} onClick={() => setOpen(!open)}>
					{open
						? t("Ocultar medios", "Hide outlets")
						: t(`Ver los ${story.outletCount} medios`, `See all ${story.outletCount} outlets`)}
				</button>
			</div>
			{open ? <Outlets story={story} /> : null}
		</li>
	);
}

/** The chronological list: one meta row for every story (time · outlet · place · topic). */
function StoryRow({ story, fresh }: { story: Story; fresh: boolean }) {
	const [open, setOpen] = useState(false);
	const l = lang.value;
	const first = story.outlets[0];
	const others = story.outletCount - 1;
	const topic = story.topics[0];
	return (
		<li class={`story${open ? " is-open" : ""}${fresh ? " is-new" : ""}`}>
			<a class="story__title" href={story.url} target="_blank" rel="noopener noreferrer">
				{fresh ? <NewTag /> : null}
				{story.video ? <span class="story__video">▶ </span> : null}
				{story.title}
			</a>
			<div class="story__meta">
				<span class="data">
					{story.outlets.every((o) => o.dateMissing)
						? t("sin fecha", "no date")
						: ago(now.value - story.at, l)}
				</span>
				<span>
					{first?.name}
					{others > 0 ? t(` y ${others} más`, ` and ${others} more`) : ""}
				</span>
				<Place story={story} />
				{first?.stance === "user" ? <MineTag /> : null}
				{topic ? <span class="tag">{TOPICS[topic][l]}</span> : null}
				{story.outletCount > 1 ? (
					<button type="button" class="story__more" aria-expanded={open} onClick={() => setOpen(!open)}>
						{open
							? t("Ocultar medios", "Hide outlets")
							: t(`Ver ${story.outletCount} medios`, `See ${story.outletCount} outlets`)}
					</button>
				) : null}
			</div>
			{open ? <Outlets story={story} /> : null}
		</li>
	);
}

export function NewsPanel() {
	const source = newsViewId();
	const mine = source === "user-news";
	const view = panels.value[source] as NewsView | undefined;
	const topic = newsTopic.value;
	const state = selectedState.value;
	const l = lang.value;
	const fresh = useFresh(source, view ? Object.keys(view.stories) : [], (id) => view?.stories[id]?.firstAt);
	const pool = view
		? Object.values(view.stories).filter(
				(s) =>
					(!topic || s.topics.includes(topic)) && (!state || s.states.includes(state)) && storyAllowed(s),
			)
		: [];
	const top = topClusters(pool, now.value);
	const carded = new Set(top.items.map((x) => x.story.id));
	const list = pool.filter((s) => !carded.has(s.id)).sort((a, b) => b.at - a.at);
	const topicEntries = view
		? (Object.entries(view.topicCounts) as [Topic, number][]).sort((a, b) => b[1] - a[1])
		: [];
	return (
		<Panel
			id="noticias"
			class="panel--news"
			title={PANEL_META.noticias.title()}
			question={PANEL_META.noticias.question()}
			feeds={PANEL_META.noticias.feeds()}
			extra={<NewPill scope="news" panel="noticias" />}
			foot={
				view && mine ? (
					<MineFoot reporting={view.outletsReporting24h} total={view.outletsTotal} items={view.items24h} />
				) : view ? (
					<>
						<span>
							{t(
								`${view.outletsReporting24h} de ${view.outletsTotal} medios publicaron en 24 h · ${view.items24h} titulares`,
								`${view.outletsReporting24h} of ${view.outletsTotal} outlets published in 24 h · ${view.items24h} headlines`,
							)}
						</span>
						<span>
							{t(
								"Temas, lugares y agrupación por reglas de palabras clave, sin IA. «Lo más cubierto»: hasta 5 historias ordenadas por el número de medios distintos que las publicaron en las últimas 12 h (empates: la más reciente); si en 12 h hay menos de 3 historias con 2 o más medios, la ventana pasa a 24 h y luego a 48 h, y el panel lo dice. «Últimas»: el resto, por hora de publicación. Un medio que publica dos veces cuenta una vez.",
								"Topics, places and grouping by keyword rules, no AI. “Most covered”: up to 5 stories ranked by how many distinct outlets published them in the last 12 h (ties: the most recent); if fewer than 3 stories had 2 or more outlets in 12 h, the window widens to 24 h, then 48 h, and the panel says so. “Latest”: the rest, by publication time. An outlet publishing twice counts once.",
							)}
						</span>
					</>
				) : null
			}
		>
			<NewsSourceTabs />
			<NewsFilterChip />
			{state ? (
				<div class="news-controls">
					<button type="button" class="filter-chip is-on" onClick={() => (selectedState.value = null)}>
						{stateName(state)} ✕
					</button>
				</div>
			) : null}
			<fieldset class="topic-chips">
				<legend class="sr-only">{t("Filtrar por tema", "Filter by topic")}</legend>
				{topicEntries.map(([k, n]) => (
					<button
						type="button"
						key={k}
						class={`filter-chip${topic === k ? " is-on" : ""}`}
						aria-pressed={topic === k}
						onClick={() => (newsTopic.value = topic === k ? null : k)}
					>
						{TOPICS[k][l]} <span class="data">{n}</span>
					</button>
				))}
			</fieldset>
			{!view ? (
				<p class="skeleton">…</p>
			) : pool.length === 0 ? (
				<p class="empty">
					{t("Nada con ese filtro en las últimas 48 h.", "Nothing with that filter in the last 48 h.")}
				</p>
			) : (
				<>
					{top.items.length ? (
						<section class="news-top" aria-labelledby="news-top-title">
							<h3 class="news-top__title" id="news-top-title">
								<span class="caps">{t("Lo más cubierto", "Most covered")}</span>
								<span class="news-top__rule">
									{t(
										`medios distintos en ${top.hours} h · reglas, sin IA`,
										`distinct outlets in ${top.hours} h · rules, no AI`,
									)}
								</span>
							</h3>
							<ol class="news-cards">
								{top.items.map((x) => (
									<ClusterCard
										key={x.story.id}
										story={x.story}
										outlets={x.outlets}
										hours={top.hours}
										fresh={fresh.has(x.story.id)}
									/>
								))}
							</ol>
						</section>
					) : null}
					<h3 class="news-top__title">
						<span class="caps">{t("Últimas", "Latest")}</span>
						<span class="news-top__rule">{t("en orden de publicación", "in order of publication")}</span>
					</h3>
					<ol class="stories">
						{list.slice(0, 25).map((s) => (
							<StoryRow story={s} key={s.id} fresh={fresh.has(s.id)} />
						))}
					</ol>
				</>
			)}
		</Panel>
	);
}
