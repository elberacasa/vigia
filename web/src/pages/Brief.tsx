import { useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { panels, refreshPanels } from "../lib/data.ts";
import { stamp } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import pagesCss from "../styles/pages.css?inline";
import panelsCss from "../styles/panels.css?inline";

addStyles(panelsCss);
addStyles(pagesCss);

interface BriefView {
	day: string;
	generatedAt: number;
	figures: { label: string; value: string; source: string; observedAt: number | null; url: string | null }[];
	stories: { title: string; url: string; outlets: string[]; at: number; state: string | null }[];
	text: string;
	method: string;
}

interface Written {
	day: string;
	model: string;
	text: string;
	at: number;
	dataAt: number;
	sources: string[];
}

function WrittenBrief() {
	const ai = panels.value.ai as { briefBackend: string; writtenBrief: Written | null } | undefined;
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (!ai || ai.briefBackend === "off") return null;
	const w = ai.writtenBrief;
	return (
		<section class="brief__section ai-card">
			<h2 class="status-group__title">
				{t("Escrito por IA (opcional)", "Written by AI (optional)")}{" "}
				{w ? <span class="tag">{w.model}</span> : null}
			</h2>
			{w ? (
				<>
					<p class="brief__written">{w.text}</p>
					<details>
						<summary class="note">{t("Fuentes citadas", "Cited sources")}</summary>
						<ol class="note">
							{w.sources.map((src) => (
								<li key={src}>{src}</li>
							))}
						</ol>
					</details>
					<p class="note">
						{t(
							`Escrito ${stamp(w.at, "es")} con los datos de ${stamp(w.dataAt, "es")} (hora de Caracas). Texto de IA, no un hecho: las reglas solo garantizan que cada oración cite sus fuentes y que las cifras las ponga Vigía, no el modelo. Puede resumir mal u omitir algo; las cifras de arriba son las que valen.`,
							`Written ${stamp(w.at, "en")} from the data of ${stamp(w.dataAt, "en")} (Caracas time). AI text, not fact: the rules only guarantee that every sentence cites its sources and that Vigía, not the model, writes the figures. It may summarise badly or leave things out; the figures above are what count.`,
						)}
					</p>
				</>
			) : null}
			<button
				type="button"
				class="button"
				disabled={busy}
				onClick={async () => {
					setBusy(true);
					setError(null);
					const res = await fetch("/api/ai/brief", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: "{}",
					});
					const body = (await res.json().catch(() => ({}))) as { reason?: string; error?: string };
					if (!res.ok) setError(body.reason ?? body.error ?? `HTTP ${res.status}`);
					await refreshPanels(["ai"]);
					setBusy(false);
				}}
			>
				{busy
					? t("Escribiendo…", "Writing…")
					: w
						? t("Volver a escribir", "Write again")
						: t("Escribir el resumen con IA", "Write the brief with AI")}
			</button>
			{error ? (
				<p class="key-form__error" role="alert">
					{error}
				</p>
			) : null}
		</section>
	);
}

/** The daily brief built by code: figures with sources and the most-covered stories; copy it as plain text. */
export function BriefPage() {
	const view = panels.value.brief as BriefView | undefined;
	const [copied, setCopied] = useState(false);
	const l = lang.value;
	return (
		<main class="page brief">
			<header class="page__head">
				<p class="caps page__kicker">{t("Resumen del día", "Daily brief")}</p>
				<h1 class="page__title">{view ? t(`Venezuela, ${view.day}`, `Venezuela, ${view.day}`) : "…"}</h1>
				<p class="page__lede">{view?.method}</p>
				{view ? (
					<button
						type="button"
						class="button button--primary brief__copy"
						onClick={async () => {
							try {
								await navigator.clipboard.writeText(view.text);
								setCopied(true);
								setTimeout(() => setCopied(false), 2_500);
							} catch {
								setCopied(false);
							}
						}}
					>
						{copied
							? t("Copiado ✓", "Copied ✓")
							: t("Copiar como texto (WhatsApp, Telegram)", "Copy as text (WhatsApp, Telegram)")}
					</button>
				) : null}
				{view ? (
					<p class="note brief__exports">
						<a class="link" href="/informe">
							{t("Informe para imprimir o guardar en PDF", "Report to print or save as PDF")}
						</a>
						{" · "}
						<a class="link" href="/api/v1/panels/brief/figures?format=csv" download>
							{t("Cifras en CSV", "Figures as CSV")}
						</a>
						{" · "}
						<a class="link" href="/api">
							{t("API de datos", "Data API")}
						</a>
					</p>
				) : null}
			</header>
			{!view ? (
				<p class="skeleton">…</p>
			) : (
				<>
					<section class="brief__section">
						<h2 class="status-group__title">{t("Cifras", "Figures")}</h2>
						<dl class="brief__figures">
							{view.figures.map((f) => (
								<div key={f.label}>
									<dt>{f.label}</dt>
									<dd>
										{f.value}{" "}
										<span class="note">
											{f.url ? (
												<a class="link" href={f.url} target="_blank" rel="noopener noreferrer">
													{f.source}
												</a>
											) : (
												f.source
											)}
											{f.observedAt ? ` · ${stamp(f.observedAt, l)}` : ""}
										</span>
									</dd>
								</div>
							))}
						</dl>
					</section>
					<WrittenBrief />
					<section class="brief__section">
						<h2 class="status-group__title">
							{t("Lo más cubierto en 24 horas", "Most covered in 24 hours")}
						</h2>
						<ol class="brief__stories">
							{view.stories.map((s) => (
								<li key={s.url}>
									<a href={s.url} target="_blank" rel="noopener noreferrer" class="story__title">
										{s.title}
									</a>
									<span class="note">
										{s.state ? `${s.state} · ` : ""}
										{s.outlets.length}{" "}
										{s.outlets.length === 1 ? t("medio", "outlet") : t("medios", "outlets")}:{" "}
										{s.outlets.join(", ")}
									</span>
								</li>
							))}
						</ol>
					</section>
				</>
			)}
		</main>
	);
}
