import {
	type AnomalyItem,
	changeLine,
	explainedText,
	itemPath,
	memberLine,
	scoreText,
	sourceUrl,
	whenLine,
} from "../lib/anomaly-view.ts";
import { addStyles } from "../lib/css.ts";
import { tick } from "../lib/data.ts";
import { entityPath } from "../lib/entity-route.ts";
import { int } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { openIncident } from "../lib/keys.ts";
import { entityLink } from "../lib/router.ts";
import unusualCss from "../styles/unusual.css?inline";

addStyles(unusualCss);

/*
 * One list of unusual readings, for the "Lo inusual ahora" panel and an entity's page: each with its rule in words,
 * its change and (when the source allows) its value against the baseline, the baseline's window, the score, the
 * source and its age, "calculado por Vigía" with the method, and what incident already explains it. Regional items
 * list every state with its own figure. No status colour: an unusual figure is rare, not necessarily bad.
 */

function Dir({ a }: { a: AnomalyItem }) {
	const up = a.direction === "up";
	return (
		<span class={`an__dir an__dir--${a.direction}`} title={up ? t("sube", "up") : t("baja", "down")}>
			<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
				<path d={up ? "M5 1.5 9 8.5H1Z" : "M5 8.5 1 1.5h8Z"} />
			</svg>
			<span class="sr-only">{up ? t("Sube:", "Up:") : t("Baja:", "Down:")}</span>
		</span>
	);
}

function Method({ method }: { method: string }) {
	return (
		<details class="an__more">
			<summary>{t("calculado por Vigía", "computed by Vigía")}</summary>
			<p>{method}</p>
		</details>
	);
}

export function AnomalyRow({ a, self }: { a: AnomalyItem; self?: string | null }) {
	const l = lang.value;
	const n = tick.value;
	const path = itemPath(a);
	const src = sourceUrl(a);
	const change = changeLine(a, l);
	return (
		<li
			class={`an an--${a.direction}${a.explainedBy ? " is-explained" : ""}${a.reverted ? " is-reverted" : ""}`}
		>
			<div class="an__head">
				<Dir a={a} />
				<span class="an__title">{a.title[l]}</span>
			</div>
			{change ? <p class="an__change mono">{change}</p> : null}
			{a.members?.length ? (
				<ul
					class="an__members"
					aria-label={t("Cada estado, con su propia cifra", "Each state, with its own figure")}
				>
					{a.members.map((m) => {
						const p = entityPath(m.entity.id);
						return (
							<li key={m.entity.id}>
								{p ? <a {...entityLink(m.entity.id)}>{m.entity.name[l]}</a> : <span>{m.entity.name[l]}</span>}
								<span class="mono">{memberLine(m, n, l)}</span>
								{m.explainedBy ? <span class="an__member-x">{explainedText(m.explainedBy, l)}</span> : null}
							</li>
						);
					})}
				</ul>
			) : null}
			{a.reverted ? <p class="an__reverted">{a.reverted.text[l]}</p> : null}
			<p class="an__window">
				{t("Línea base", "Baseline")}: {a.window.text[l]}
				{a.window.points ? ` (${int(a.window.points, l)} ${t("datos", "points")})` : ""}
			</p>
			{a.explainedBy ? (
				<p class="an__explained">
					<button type="button" class="link-button" onClick={() => openIncident(a.explainedBy?.id ?? "")}>
						{explainedText(a.explainedBy, l)}
					</button>
				</p>
			) : null}
			<div class="an__prov">
				{src ? (
					<a class="an__src" href={src} target="_blank" rel="noopener noreferrer">
						{a.source.name}
					</a>
				) : (
					<span class="an__src">{a.source.name}</span>
				)}
				<span class="mono">{whenLine(a, n, l)}</span>
				<span class="an__basis">{t("derivado", "derived")}</span>
				<Method method={a.method} />
				<details class="an__more">
					<summary>{t("regla", "rule")}</summary>
					<p>{a.rule[l]}</p>
					<p>
						{t(
							"Puntuación (desviaciones robustas de su mediana; inusual desde 4)",
							"Score (robust deviations from its median; unusual from 4)",
						)}
						: <span class="mono">{scoreText(a.score, l)}</span>
					</p>
				</details>
				{path && a.entity.id !== self && a.entity.id !== "ve" ? (
					<a class="an__entity" {...entityLink(a.entity.id)}>
						{a.entity.name[l]} <span aria-hidden="true">→</span>
					</a>
				) : null}
			</div>
		</li>
	);
}

export function AnomalyList({ items, self = null }: { items: readonly AnomalyItem[]; self?: string | null }) {
	return (
		<ol class="an-list">
			{items.map((a) => (
				<AnomalyRow key={a.id} a={a} self={self} />
			))}
		</ol>
	);
}
