import { useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { now, panels, refreshPanels } from "../lib/data.ts";
import { ago, num } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { stateName } from "../lib/states.ts";
import pagesCss from "../styles/pages.css?inline";
import panelsCss from "../styles/panels.css?inline";

addStyles(panelsCss);
addStyles(pagesCss);

/** Mirrors src/ai/runtime.ts AiView. */
type Metric = number | null;
interface Results {
	about: Metric;
	blackoutP: Metric;
	blackoutR: Metric;
	topicsMicroF1: Metric;
	event: Metric;
	stateSpecific: Metric;
}
interface AiReport {
	key: string;
	title: string;
	url: string;
	outlet: string;
	at: number;
	state: string;
	stateConfidence: number;
	probability: number;
	severity: number;
}
interface AiView {
	backend: "off" | "local" | "jev";
	model: string | null;
	jevAvailable: boolean;
	evaluation: {
		date: string;
		goldItems: number;
		randomItems: number;
		marks: { about: number; blackoutPR: number; topicsMicroF1: number; event: number; stateSpecific: number };
		results: Record<string, Results>;
		localPassed: boolean;
	};
	spend: { provider: string; requests: number; costUsd: number; budgetUsd: number }[];
	lastRun: { at: number; labelled: number; error: string | null } | null;
	blackouts: AiReport[];
	serious: AiReport[];
	blackoutsByState: Record<string, number>;
	labelledItems48h: number;
	briefBackend: "off" | "anthropic" | "claude-code" | "ollama";
	anthropicAvailable: boolean;
}

async function save(body: unknown): Promise<string | null> {
	const res = await fetch("/api/ai/settings", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok)
		return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`;
	await refreshPanels(["ai"]);
	return null;
}

const MODEL_NAME: Record<string, { es: string; en: string }> = {
	rules: { es: "Reglas de palabras clave (sin IA)", en: "Keyword rules (no AI)" },
	"jev-1.13.0": { es: "Jev 1.13 (TypeSafe, de pago)", en: "Jev 1.13 (TypeSafe, paid)" },
	"vigia-local-news-1": {
		es: "Modelo local de Vigía (gratis, sin conexión)",
		en: "Vigía local model (free, offline)",
	},
};

function Cell({ value, mark }: { value: Metric; mark?: number }) {
	if (value === null) return <td class="data muted">—</td>;
	const pass = mark === undefined ? null : value >= mark;
	return (
		<td class={`data ${pass === null ? "" : pass ? "pass" : "fail"}`}>{num(value * 100, 1, lang.value)} %</td>
	);
}

function BudgetForm(props: {
	provider: string;
	label: string;
	spend: { requests: number; costUsd: number; budgetUsd: number } | undefined;
	onError: (e: string | null) => void;
}) {
	const [value, setValue] = useState("");
	const l = lang.value;
	return (
		<form
			class="key-form"
			onSubmit={async (e) => {
				e.preventDefault();
				const v = Number(value.replace(",", "."));
				if (!Number.isFinite(v) || v < 0) {
					props.onError(t("Presupuesto no válido.", "Invalid budget."));
					return;
				}
				props.onError(await save({ budgetUsd: { [props.provider]: v } }));
				setValue("");
			}}
		>
			<label class="note" for={`budget-${props.provider}`}>
				{props.label}: <strong class="data">{num(props.spend?.budgetUsd ?? 0, 2, l)}</strong> ·{" "}
				{t("gastado", "spent")} <strong class="data">{num(props.spend?.costUsd ?? 0, 4, l)}</strong> (
				{props.spend?.requests ?? 0} {t("consultas", "requests")})
			</label>
			<input
				id={`budget-${props.provider}`}
				class="key-form__input data"
				inputMode="decimal"
				placeholder="5"
				value={value}
				onInput={(e) => setValue((e.target as HTMLInputElement).value)}
			/>
			<button type="submit" class="button">
				{t("Guardar presupuesto", "Save budget")}
			</button>
		</form>
	);
}

export function AiPage() {
	const view = panels.value.ai as AiView | undefined;
	const [error, setError] = useState<string | null>(null);
	const [budget, setBudget] = useState("");
	const l = lang.value;
	const typesafe = view?.spend.find((s) => s.provider === "typesafe");
	const choose = async (news: AiView["backend"]) => {
		setError(await save({ news }));
	};
	return (
		<main class="page ai-page">
			<header class="page__head">
				<p class="caps page__kicker">{t("Capa IA · opcional", "AI section · optional")}</p>
				<h1 class="page__title">
					{t("Lo que un modelo puede añadir, medido", "What a model can add, measured")}
				</h1>
				<p class="page__lede">
					{t(
						"Vigía funciona completo sin IA. Aquí puedes activar modelos que clasifican noticias. Cada resultado dice qué modelo lo produjo, puede equivocarse, y su precisión está medida contra un conjunto de noticias etiquetadas a mano por revisores independientes. Ningún modelo produce cifras.",
						"Vigía works fully without AI. Here you can turn on models that classify news. Every result names the model that produced it, may be wrong, and its accuracy is measured against news labelled by independent reviewers. No model produces figures.",
					)}
				</p>
			</header>

			{!view ? (
				<p class="skeleton">…</p>
			) : (
				<>
					<section
						class="table-wrap"
						// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1).
						tabIndex={0}
						aria-labelledby="ai-eval-title"
					>
						<h2 class="guide__step-title">{t("Clasificar noticias", "Classify news")}</h2>
						<p class="note">
							{t(
								"Tema, tipo de hecho, estado, gravedad y si reporta un apagón. Sirve para detectar reportes de apagón por estado y hechos graves.",
								"Topic, event type, state, severity and whether it reports a blackout. Used to detect blackout reports by state and serious events.",
							)}
						</p>
						<div class="segmented segmented--wide" role="radiogroup" aria-label={t("Modelo", "Model")}>
							{(
								[
									["off", t("Apagado", "Off")],
									["local", t("Modelo local (experimental)", "Local model (experimental)")],
									["jev", t("Jev (TypeSafe)", "Jev (TypeSafe)")],
								] as const
							).map(([k, label]) => (
								<button
									type="button"
									key={k}
									aria-pressed={view.backend === k}
									disabled={k === "jev" && !view.jevAvailable}
									onClick={() => void choose(k)}
								>
									{label}
								</button>
							))}
						</div>
						{!view.jevAvailable ? (
							<p class="note">
								{t(
									"Jev necesita una clave de TypeSafe (de pago por uso). Agrégala en Configurar.",
									"Jev needs a TypeSafe key (pay per use). Add it in Set up.",
								)}
							</p>
						) : (
							<form
								class="key-form"
								onSubmit={async (e) => {
									e.preventDefault();
									const v = Number(budget.replace(",", "."));
									if (!Number.isFinite(v) || v < 0) {
										setError(t("Presupuesto no válido.", "Invalid budget."));
										return;
									}
									setError(await save({ budgetUsd: { typesafe: v } }));
									setBudget("");
								}}
							>
								<label class="note" for="ai-budget">
									{t("Presupuesto máximo total para Jev (US$)", "Maximum total budget for Jev (US$)")}:{" "}
									<strong class="data">{num(typesafe?.budgetUsd ?? 0, 2, l)}</strong> ·{" "}
									{t("gastado", "spent")} <strong class="data">{num(typesafe?.costUsd ?? 0, 4, l)}</strong> (
									{typesafe?.requests ?? 0} {t("consultas", "requests")})
								</label>
								<input
									id="ai-budget"
									class="key-form__input data"
									inputMode="decimal"
									placeholder="5"
									value={budget}
									onInput={(e) => setBudget((e.target as HTMLInputElement).value)}
								/>
								<button type="submit" class="button">
									{t("Guardar presupuesto", "Save budget")}
								</button>
							</form>
						)}
						{error ? (
							<p class="key-form__error" role="alert">
								{error}
							</p>
						) : null}

						<h3 class="caps state-block__title" id="ai-eval-title">
							{t(
								`Precisión medida (${view.evaluation.goldItems} noticias etiquetadas, ${view.evaluation.date})`,
								`Measured accuracy (${view.evaluation.goldItems} labelled news items, ${view.evaluation.date})`,
							)}
						</h3>
						{/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1) */}
						<section class="table-wrap" tabIndex={0} aria-labelledby="ai-eval-title">
							<table class="status-table ai-table">
								<thead>
									<tr>
										<th scope="col">{t("Método", "Method")}</th>
										<th scope="col">{t("¿Sobre Venezuela?", "About Venezuela?")}</th>
										<th scope="col">{t("Apagón: precisión", "Blackout: precision")}</th>
										<th scope="col">{t("Apagón: cobertura", "Blackout: recall")}</th>
										<th scope="col">{t("Temas (F1)", "Topics (F1)")}</th>
										<th scope="col">{t("Tipo de hecho", "Event type")}</th>
										<th scope="col">{t("Estado", "State")}</th>
									</tr>
								</thead>
								<tbody>
									{Object.entries(view.evaluation.results).map(([id, r]) => {
										const m = id === "vigia-local-news-1" ? view.evaluation.marks : undefined;
										return (
											<tr key={id}>
												<th scope="row">{MODEL_NAME[id]?.[l] ?? id}</th>
												<Cell value={r.about} {...(m ? { mark: m.about } : {})} />
												<Cell value={r.blackoutP} {...(m ? { mark: m.blackoutPR } : {})} />
												<Cell value={r.blackoutR} {...(m ? { mark: m.blackoutPR } : {})} />
												<Cell value={r.topicsMicroF1} {...(m ? { mark: m.topicsMicroF1 } : {})} />
												<Cell value={r.event} {...(m ? { mark: m.event } : {})} />
												<Cell value={r.stateSpecific} {...(m ? { mark: m.stateSpecific } : {})} />
											</tr>
										);
									})}
								</tbody>
							</table>
						</section>
						<p class="note">
							{view.evaluation.localPassed
								? t(
										"El modelo local cumplió todas las metas fijadas de antemano.",
										"The local model met every mark set in advance.",
									)
								: t(
										"El modelo local no cumplió todas las metas fijadas de antemano (en rojo): por eso es experimental y no es el predeterminado. Las reglas de palabras clave siguen siendo la base de Vigía.",
										"The local model did not meet every mark set in advance (in red): so it is experimental and not the default. Keyword rules remain Vigía's baseline.",
									)}{" "}
							{t(
								"Metas: 90 % sobre Venezuela, 80 % precisión y cobertura de apagones, F1 0,75 en temas, 70 % tipo de hecho, 80 % estado.",
								"Marks: 90% about Venezuela, 80% blackout precision and recall, topics F1 0.75, 70% event type, 80% state.",
							)}
						</p>
					</section>

					<section class="ai-card">
						<h2 class="guide__step-title">{t("Resumen escrito", "Written brief")}</h2>
						<p class="note">
							{t(
								"Un párrafo escrito a partir del resumen hecho por código. Cada oración debe citar sus fuentes y cada número debe aparecer tal cual en ellas; si no, Vigía lo descarta. Se escribe solo cuando lo pides.",
								"A paragraph written from the code-built brief. Every sentence must cite its sources and every number must appear verbatim in them; otherwise Vigía discards it. Written only when you ask.",
							)}
						</p>
						<div class="segmented segmented--wide">
							{(
								[
									["off", t("Apagado", "Off")],
									["anthropic", t("Claude (tu clave)", "Claude (your key)")],
									["claude-code", t("Tu Claude Code", "Your Claude Code")],
									["ollama", t("Ollama (local)", "Ollama (local)")],
								] as const
							).map(([k, label]) => (
								<button
									type="button"
									key={k}
									aria-pressed={view.briefBackend === k}
									disabled={k === "anthropic" && !view.anthropicAvailable}
									onClick={async () => setError(await save({ brief: k }))}
								>
									{label}
								</button>
							))}
						</div>
						<p class="note">
							{t(
								"Claude usa tu clave de Anthropic (de pago, dentro del presupuesto de abajo). Claude Code usa tu propia suscripción en este equipo, sin herramientas ni acceso a tus archivos. Ollama corre un modelo local gratis.",
								"Claude uses your Anthropic key (paid, within the budget below). Claude Code uses your own subscription on this machine, with no tools and no access to your files. Ollama runs a free local model.",
							)}
						</p>
						<p class="note">
							{t(
								"Para conectar tu Claude Code en un paso, escribe en la terminal ",
								"To connect your Claude Code in one step, type in the terminal ",
							)}
							<code class="data">vigia ia conectar</code>
							{t(
								": comprueba que tiene sesión y lo elige aquí (se apaga con ",
								": it checks that it is logged in and selects it here (turn it off with ",
							)}
							<code class="data">vigia ia desconectar</code>
							{t("). ¿Tienes un agente de IA? ", "). Have an AI coding agent? ")}
							<a
								class="link"
								href="https://github.com/elberacasa/vigia/blob/main/docs/AGENT-SETUP.md"
								target="_blank"
								rel="noopener noreferrer"
							>
								{t(
									"Pégale esto para instalar y configurar Vigía",
									"Paste this into it to install and set up Vigía",
								)}
							</a>
							.
						</p>
						{view.anthropicAvailable ? (
							<BudgetForm
								provider="anthropic"
								label={t(
									"Presupuesto máximo total para Claude (US$)",
									"Maximum total budget for Claude (US$)",
								)}
								spend={view.spend.find((x) => x.provider === "anthropic")}
								onError={setError}
							/>
						) : null}
					</section>

					{view.backend !== "off" ? (
						<section class="ai-card">
							<h2 class="guide__step-title">
								{t("Reportes de apagón detectados, 48 h", "Blackout reports detected, 48 h")}
								<span class="tag">{view.model ?? "…"}</span>
							</h2>
							{view.lastRun?.error ? <p class="key-form__error">{view.lastRun.error}</p> : null}
							<p class="note">
								{t(
									`${view.labelledItems48h} noticias clasificadas. Detectado por modelo: verifica en la fuente.`,
									`${view.labelledItems48h} items classified. Detected by a model: check the source.`,
								)}
							</p>
							{Object.keys(view.blackoutsByState).length ? (
								<p class="chips">
									{Object.entries(view.blackoutsByState)
										.sort((a, b) => b[1] - a[1])
										.map(([iso, n]) => (
											<span class="chip-feed" key={iso}>
												{stateName(iso)} <strong class="data">{n}</strong>
											</span>
										))}
								</p>
							) : null}
							{view.blackouts.length ? (
								<ul class="stories">
									{view.blackouts.map((r) => (
										<li class="story" key={r.key}>
											<a class="story__title" href={r.url} target="_blank" rel="noopener noreferrer">
												{r.title}
											</a>
											<div class="story__meta">
												<span class="data">{ago(now.value - r.at, l)}</span>
												<span>{r.outlet}</span>
												{/^VE-/.test(r.state) ? <span class="story__place">{stateName(r.state)}</span> : null}
												<span class="tag">
													{t("probabilidad", "probability")} {num(r.probability * 100, 0, l)} %
												</span>
											</div>
										</li>
									))}
								</ul>
							) : (
								<p class="empty">{t("Ninguno en 48 h.", "None in 48 h.")}</p>
							)}
							<h3 class="caps state-block__title">{t("Hechos graves, 24 h", "Serious events, 24 h")}</h3>
							{view.serious.length ? (
								<ul class="stories">
									{view.serious.map((r) => (
										<li class="story" key={r.key}>
											<a class="story__title" href={r.url} target="_blank" rel="noopener noreferrer">
												{r.title}
											</a>
											<div class="story__meta">
												<span class="data">{ago(now.value - r.at, l)}</span>
												<span>{r.outlet}</span>
												{/^VE-/.test(r.state) ? <span class="story__place">{stateName(r.state)}</span> : null}
												<span class="tag">
													{t("gravedad", "severity")} {num(r.severity, 1, l)}/3
												</span>
											</div>
										</li>
									))}
								</ul>
							) : (
								<p class="empty">{t("Ninguno en 24 h.", "None in 24 h.")}</p>
							)}
						</section>
					) : null}
				</>
			)}
		</main>
	);
}
