import { useEffect, useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { now, panels, wantPanel } from "../lib/data.ts";
import type { FactCheck, FactCheckView } from "../lib/factchecks.ts";
import { ago, int, stamp } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { readableWords } from "../lib/media.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import { registerSummary } from "../lib/summary.ts";
import newsxCss from "../styles/newsx.css?inline";
import { Panel } from "../ui/Panel.tsx";

addStyles(newsxCss);

/**
 * "Desmentidos": what Venezuelan and regional fact-checkers published in 30 days, each with the verdict the checker's
 * own headline states (none shown when it states none), and the news story it most likely concerns, said as a
 * possible relation with the words in common (a match of words, never a confirmation).
 */

function Verdict({ f, view }: { f: FactCheck; view: FactCheckView }) {
	if (!f.verdict)
		return (
			<span class="fc-verdict fc-verdict--none">
				{t("sin veredicto en el titular", "no verdict in the headline")}
			</span>
		);
	return <span class={`fc-verdict fc-verdict--${f.verdict}`}>{view.verdicts[f.verdict][lang.value]}</span>;
}

function Item({ f, view }: { f: FactCheck; view: FactCheckView }) {
	const l = lang.value;
	const r = f.related;
	return (
		<li class="fc-item">
			<div class="fc-item__head">
				<Verdict f={f} view={view} />
				<span class="fc-item__who">
					{f.checkerName}
					{f.via === "google-news" ? (
						<span class="fc-item__via"> · {t("vía Google Noticias", "via Google News")}</span>
					) : null}
				</span>
				<time class="fc-item__time" dateTime={new Date(f.at).toISOString()}>
					{f.dateMissing ? t("sin fecha", "no date") : stamp(f.at, l, now.value)}
				</time>
			</div>
			<a class="fc-item__title" href={f.url} target="_blank" rel="noopener noreferrer">
				{f.title}
			</a>
			{r ? (
				<p class="fc-rel">
					<span class="fc-rel__label">
						{t("posible relación", "possibly related")} · {t("palabras en común", "words in common")}:{" "}
						<span class="fc-rel__words">{readableWords(r.sharedWords, f.title).join(", ")}</span>
					</span>
					<a class="fc-rel__story" href={r.url} target="_blank" rel="noopener noreferrer">
						{r.outletName}: {r.title}
					</a>
					<span class="fc-rel__when">{ago(now.value - r.at, l)}</span>
				</p>
			) : null}
		</li>
	);
}

export function FactChecksPanel() {
	const l = lang.value;
	const view = panels.value.desmentidos as FactCheckView | undefined;
	const [failed, setFailed] = useState(false);
	const [checker, setChecker] = useState<string | null>(null);
	useEffect(() => {
		wantPanel("desmentidos").catch(() => setFailed(true));
	}, []);
	const meta = PANEL_META.desmentidos;
	const items = view ? view.items.filter((f) => !checker || f.checker === checker) : [];
	const v = view?.byVerdict ?? {};
	return (
		<Panel
			id="desmentidos"
			title={meta.title()}
			question={meta.question()}
			feeds={meta.feeds()}
			ready={failed || view !== undefined}
			method={
				view ? (
					<>
						<p>{l === "es" ? view.methodEs : view.methodEn}</p>
						<p>
							{t(
								"Se listan todas las publicaciones de los verificadores (no todas son verificaciones: también publican reportajes y avisos); las páginas de etiquetas, archivos y autores se descartan. El veredicto califica una afirmación que el verificador revisó, nunca a un medio.",
								"Every post by the fact-checkers is listed (not all are checks: they also publish reports and notices); tag, archive and author pages are dropped. A verdict rates a claim the checker reviewed, never an outlet.",
							)}
						</p>
					</>
				) : null
			}
		>
			{failed && !view ? (
				<p class="gd-note">
					{t("No se pudieron cargar las verificaciones.", "The fact-checks could not be loaded.")}{" "}
					<button
						type="button"
						class="link-button"
						onClick={() => {
							setFailed(false);
							wantPanel("desmentidos").catch(() => setFailed(true));
						}}
					>
						{t("Reintentar", "Retry")}
					</button>
				</p>
			) : null}
			{view ? (
				<div class="fc">
					<dl class="gd-figs">
						<div>
							<dt>{t("Publicaciones, 30 días", "Posts, 30 days")}</dt>
							<dd>{int(view.items.length, l)}</dd>
						</div>
						<div>
							<dt>{view.verdicts.false[l]}</dt>
							<dd>{int(v.false ?? 0, l)}</dd>
						</div>
						<div>
							<dt>{t("Otros veredictos", "Other verdicts")}</dt>
							<dd>
								{int(
									(v.misleading ?? 0) +
										(v.context ?? 0) +
										(v.partly ?? 0) +
										(v.unproven ?? 0) +
										(v.satire ?? 0) +
										(v.true ?? 0),
									l,
								)}
								<span class="gd-figs__note">
									{t("engañoso, falta contexto, impreciso…", "misleading, missing context, partly…")}
								</span>
							</dd>
						</div>
						<div>
							<dt>{t("Sin veredicto en el titular", "No verdict in the headline")}</dt>
							<dd>{int(v.none ?? 0, l)}</dd>
						</div>
						<div>
							<dt>{t("Relacionadas", "Related")}</dt>
							<dd>
								{int(view.related, l)}
								<span class="gd-figs__note">
									{t("posiblemente, a una noticia leída", "possibly, to a story read")}
								</span>
							</dd>
						</div>
					</dl>
					<fieldset class="fc-checkers">
						<legend class="sr-only">{t("Verificador", "Checker")}</legend>
						<button
							type="button"
							class={`filter-chip${checker === null ? " is-on" : ""}`}
							aria-pressed={checker === null}
							onClick={() => setChecker(null)}
						>
							{t("Todos", "All")} <span class="data">{view.items.length}</span>
						</button>
						{view.byChecker.map((c) => (
							<button
								type="button"
								key={c.id}
								class={`filter-chip${checker === c.id ? " is-on" : ""}`}
								aria-pressed={checker === c.id}
								onClick={() => setChecker(checker === c.id ? null : c.id)}
							>
								{c.name} <span class="data">{c.items}</span>
							</button>
						))}
					</fieldset>
					{items.length ? (
						<ol class="fc-list">
							{items.map((f) => (
								<Item key={f.id} f={f} view={view} />
							))}
						</ol>
					) : (
						<p class="gd-note">{t("Ninguna verificación en 30 días.", "No fact-check in 30 days.")}</p>
					)}
				</div>
			) : null}
		</Panel>
	);
}

registerSummary("desmentidos", () => {
	const v = panels.value.desmentidos as FactCheckView | undefined;
	if (!v) return null;
	const f = v.byVerdict.false ?? 0;
	return {
		text: t(
			`${v.items.length} publicaciones de verificadores en 30 días${f ? `, ${f} con veredicto «falso»` : ""}`,
			`${v.items.length} fact-checker posts in 30 days${f ? `, ${f} rated “false”` : ""}`,
		),
		tone: "normal",
	};
});
