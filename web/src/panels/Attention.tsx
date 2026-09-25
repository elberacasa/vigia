import { useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { panels } from "../lib/data.ts";
import { int, num } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import attentionCss from "../styles/attention.css?inline";
import panelsCss from "../styles/panels.css?inline";
import { Panel } from "../ui/Panel.tsx";
import { SourceTag } from "../ui/Source.tsx";
import { Sparkline } from "../ui/Sparkline.tsx";

addStyles(panelsCss);

addStyles(attentionCss);

/* Mirrors src/panels/attention.ts. */

interface ArticleRow {
	project: string;
	lang: "es" | "en" | "pt";
	title: string;
	label: string;
	views: number | null;
	median28: number | null;
	ratio: number | null;
	spike: boolean;
	series: (number | null)[];
	url: string;
	toolUrl: string;
}
interface TopicRow {
	id: string;
	labelEs: string;
	labelEn: string;
	articles: ArticleRow[];
	views: number;
	spike: boolean;
	maxRatio: number | null;
	ratio: number | null;
	series: (number | null)[];
}
export interface AttentionView {
	day: string | null;
	dayAt: number | null;
	topics: TopicRow[];
	spikes: number;
	total: { views: number; median28: number | null };
	rule: { es: string; en: string };
	noteEs: string;
	noteEn: string;
	feed: string;
	sourceUrl: string;
}

function Topic({ topic }: { topic: TopicRow }) {
	const l = lang.value;
	const values = topic.series.filter((v): v is number => v !== null);
	const label = l === "es" ? topic.labelEs : topic.labelEn;
	return (
		<li class={`topic${topic.spike ? " topic--spike" : ""}`}>
			<div class="topic__head">
				<span class="topic__name">{label}</span>
				<span class="topic__views data">
					{int(topic.views, l)}
					{topic.spike && topic.maxRatio !== null ? (
						<span class="topic__ratio"> ×{num(topic.maxRatio, 1, l)}</span>
					) : null}
				</span>
			</div>
			<Sparkline
				values={values}
				width={200}
				height={22}
				tone={topic.spike ? "signal" : "muted"}
				summary={t(
					`${label}: lecturas diarias de los últimos ${values.length} días`,
					`${label}: daily reads, last ${values.length} days`,
				)}
			/>
			<span class="topic__langs">
				{topic.articles.map((a) => (
					<a
						key={a.project + a.title}
						class={`topic__lang${a.spike ? " is-spike" : ""}`}
						href={a.toolUrl}
						target="_blank"
						rel="noopener noreferrer"
						title={t(
							`${a.label} (${a.lang}): ${a.views ?? "—"} lecturas; mediana de 28 días ${a.median28 ?? "—"}`,
							`${a.label} (${a.lang}): ${a.views ?? "—"} reads; 28-day median ${a.median28 ?? "—"}`,
						)}
					>
						<span class="topic__code">{a.lang}</span>
						<span class="data">{a.views === null ? "—" : int(a.views, l)}</span>
					</a>
				))}
			</span>
		</li>
	);
}

export function AttentionPanel() {
	const view = panels.value.attention as AttentionView | undefined;
	const [all, setAll] = useState(false);
	const l = lang.value;
	const shown = view ? (all ? view.topics : view.topics.slice(0, 5)) : [];
	return (
		<Panel
			id="atencion"
			title={PANEL_META.atencion.title()}
			question={PANEL_META.atencion.question()}
			feeds={PANEL_META.atencion.feeds()}
			method={
				view ? (
					<>
						<p>{l === "es" ? view.noteEs : view.noteEn}</p>
						<p>{l === "es" ? view.rule.es : view.rule.en}</p>
						<p>
							{t(
								"Cada tema suma sus artículos en español (es), inglés (en) y portugués (pt). Cada código de idioma abre la herramienta de páginas vistas de Wikimedia.",
								"Each topic adds up its articles in Spanish (es), English (en) and Portuguese (pt). Each language code opens Wikimedia's pageviews tool.",
							)}
						</p>
					</>
				) : null
			}
		>
			{!view ? null : (
				<div class="attention">
					<div class="stat-row stat-row--two">
						<div class="figure">
							<span class="figure__label">
								{t("Lecturas", "Reads")} {view.day ? <span class="data">{view.day}</span> : null}
							</span>
							<span class="figure__value">{int(view.total.views, l)}</span>
							<span class="note">
								{view.total.median28 !== null
									? t(
											`mediana 28 días: ${int(view.total.median28, l)}`,
											`28-day median: ${int(view.total.median28, l)}`,
										)
									: t("sin línea base aún", "no baseline yet")}
							</span>
						</div>
						<div class="figure">
							<span class="figure__label">{t("Picos", "Spikes")}</span>
							<span class={`figure__value${view.spikes ? "" : " figure__value--muted"}`}>{view.spikes}</span>
							<span class="note">{t("artículos ≥ 3× su mediana", "articles ≥ 3× their median")}</span>
						</div>
					</div>
					<ul class="topics">
						{shown.map((topic) => (
							<Topic key={topic.id} topic={topic} />
						))}
					</ul>
					{view.topics.length > 5 ? (
						<button type="button" class="link-button" onClick={() => setAll(!all)}>
							{all
								? t("Ver menos", "Show fewer")
								: t(`Ver los ${view.topics.length} temas`, `Show all ${view.topics.length} topics`)}
						</button>
					) : null}
					<p class="note">
						{t(
							"Atención, no noticias: un pico dice que mucha gente buscó el tema, no qué pasó.",
							"Attention, not news: a spike says many people looked it up, not what happened.",
						)}
					</p>
					{view.dayAt !== null ? (
						<div class="sources-row">
							<SourceTag
								source={{
									feed: view.feed,
									observedAt: view.dayAt,
									url: view.sourceUrl,
									detail: t(
										`Páginas vistas de Wikipedia por lectores humanos, día ${view.day} (UTC).`,
										`Wikipedia pageviews by human readers, day ${view.day} (UTC).`,
									),
								}}
								label="Wikimedia"
							/>
						</div>
					) : null}
				</div>
			)}
		</Panel>
	);
}
