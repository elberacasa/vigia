import { useEffect } from "preact/hooks";
import { dismissToast, toasts } from "../../lib/alerts.ts";
import { addStyles } from "../../lib/css.ts";
import { now } from "../../lib/data.ts";
import { ago } from "../../lib/format.ts";
import { lang, t } from "../../lib/i18n.ts";
import { isPanelId, reveal } from "../../lib/layout.ts";
import css from "../../styles/custom-toast.css?inline";
import { safeHref } from "./Entry.tsx";
import { notify } from "./notify.ts";

addStyles(css);

const notified = new Set<string>();

/** Alerts that fired during this visit, until dismissed. Each says what, where from, and when the data is from. */
export function Toasts() {
	const list = toasts.value;
	const ids = list.map((a) => a.id).join(",");
	useEffect(() => {
		for (const a of toasts.value) {
			if (notified.has(a.id)) continue;
			notified.add(a.id);
			void notify(a);
		}
	}, [ids]);
	if (!list.length) return null;
	const l = lang.value;
	return (
		<section class="alert-toasts" aria-label={t("Alertas", "Alerts")} aria-live="polite">
			{list.map((a) => {
				const href = safeHref(a.sourceUrl);
				return (
					<article class="alert-toast" key={a.id}>
						<p class="alert-toast__kicker caps">
							{t("Tu alerta", "Your alert")}
							{a.ruleName ? ` · ${a.ruleName}` : ""}
						</p>
						<p class="alert-toast__title">{l === "en" ? a.title.en : a.title.es}</p>
						<p class="alert-toast__meta">
							{a.source} ·{" "}
							<span class="data">
								{t(`dato de ${ago(now.value - a.observedAt, l)}`, `data ${ago(now.value - a.observedAt, l)}`)}
							</span>
						</p>
						<div class="alert-toast__actions">
							{isPanelId(a.panel) ? (
								<button
									type="button"
									class="link-button"
									onClick={() => {
										if (isPanelId(a.panel)) reveal(a.panel, true);
										dismissToast(a.id);
									}}
								>
									{t("Ver en el panel", "See in the panel")}
								</button>
							) : null}
							{href ? (
								<a class="link" href={href} target="_blank" rel="noopener noreferrer">
									{t("Evidencia", "Evidence")} ↗
								</a>
							) : null}
							<button
								type="button"
								class="alert-toast__close"
								aria-label={t("Descartar", "Dismiss")}
								onClick={() => dismissToast(a.id)}
							>
								✕
							</button>
						</div>
					</article>
				);
			})}
		</section>
	);
}
