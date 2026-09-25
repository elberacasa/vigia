import { useEffect, useRef } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { healthById, metaById, now } from "../lib/data.ts";
import { ago, fullStamp } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import sheetsCss from "../styles/sheets.css?inline";
import { openMethod, openSource, StateBadge } from "./Source.tsx";

addStyles(sheetsCss);

/** "cada 10 min", "cada 4 d": a feed's freshness budget in words. */
function budget(ms: number): string {
	const min = Math.round(ms / 60_000);
	if (min < 120) return t(`${min} min`, `${min} min`);
	const h = Math.round(min / 60);
	if (h < 48) return `${h} h`;
	return `${Math.round(h / 24)} d`;
}

/** The method sheet: the panel's notes (formerly grey footers under every panel) and its sources with their health. */
export function MethodSheet() {
	const ref = useRef<HTMLDialogElement>(null);
	const m = openMethod.value;
	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (m && !dialog.open) dialog.showModal();
		if (!m && dialog.open) dialog.close();
	}, [m]);
	const l = lang.value;
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; Escape closes the dialog natively.
		<dialog
			ref={ref}
			class="sheet sheet--method"
			aria-labelledby="method-title"
			onClose={() => {
				openMethod.value = null;
			}}
			onClick={(e) => {
				if (e.target === ref.current) openMethod.value = null;
			}}
		>
			{m ? (
				<div class="sheet__inner">
					<header class="sheet__head">
						<div>
							<p class="caps sheet__kicker">{t("Cómo leer este panel", "How to read this panel")}</p>
							<h2 id="method-title" class="sheet__title">
								{m.title}
							</h2>
							{m.question ? <p class="sheet__sub">{m.question}</p> : null}
						</div>
						<button type="button" class="sheet__close" onClick={() => (openMethod.value = null)}>
							<span aria-hidden="true">✕</span>
							<span class="sr-only">{t("Cerrar", "Close")}</span>
						</button>
					</header>
					{m.body ? <div class="method__body">{m.body}</div> : null}
					{m.feeds.length ? (
						<>
							<h3 class="caps method__h">{t("Fuentes", "Sources")}</h3>
							<ul class="method__feeds">
								{m.feeds.map((id) => {
									const meta = metaById.value.get(id);
									const h = healthById.value.get(id);
									const at = h?.newestObservedAt ?? h?.lastSuccessAt ?? null;
									const dataMs = meta?.freshness.dataMs ?? null;
									return (
										<li key={id} class="method__feed">
											<div class="method__feed-head">
												<button
													type="button"
													class="method__feed-name"
													disabled={at === null}
													onClick={() => {
														if (at === null) return;
														openMethod.value = null;
														openSource.value = { feed: id, observedAt: at };
													}}
												>
													{meta?.provider ?? id}
												</button>
												<StateBadge state={h?.state ?? "pending"} />
											</div>
											<p class="note">
												{meta ? meta.name[l] : ""}
												{at !== null ? (
													<>
														{" · "}
														<span class="data">
															{t("último dato", "latest data")} {ago(now.value - at, l)}
														</span>
													</>
												) : null}
											</p>
											{meta ? (
												<p class="note">
													{dataMs !== null
														? t(
																`Se espera un dato nuevo al menos cada ${budget(dataMs)}; pasado ese plazo la etiqueta de edad se pone ámbar, y roja al doblarlo.`,
																`New data is expected at least every ${budget(dataMs)}; past that the age label turns amber, and red at twice that.`,
															)
														: t(
																`Fuente de eventos: el silencio es normal. Vigía la revisa al menos cada ${budget(meta.freshness.fetchMs)}.`,
																`Event source: silence is normal. Vigía checks it at least every ${budget(meta.freshness.fetchMs)}.`,
															)}{" "}
													<a class="link" href={meta.licence.url} target="_blank" rel="noopener noreferrer">
														{meta.licence.name}
													</a>
												</p>
											) : null}
										</li>
									);
								})}
							</ul>
						</>
					) : null}
				</div>
			) : null}
		</dialog>
	);
}

/** Full provenance of a figure: who, when observed, when fetched, licence, the original link, feed health. */
export function SourceSheet() {
	const ref = useRef<HTMLDialogElement>(null);
	const source = openSource.value;

	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (source && !dialog.open) dialog.showModal();
		if (!source && dialog.open) dialog.close();
	}, [source]);

	const meta = source ? metaById.value.get(source.feed) : undefined;
	const health = source ? healthById.value.get(source.feed) : undefined;
	const l = lang.value;

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; Escape closes the dialog natively.
		<dialog
			ref={ref}
			class="sheet"
			aria-labelledby="sheet-title"
			onClose={() => {
				openSource.value = null;
			}}
			onClick={(e) => {
				if (e.target === ref.current) openSource.value = null;
			}}
		>
			{source ? (
				<div class="sheet__inner">
					<header class="sheet__head">
						<div>
							<p class="caps sheet__kicker">{t("Fuente", "Source")}</p>
							<h2 id="sheet-title" class="sheet__title">
								{meta?.provider ?? source.feed}
							</h2>
							<p class="sheet__sub">{meta ? meta.name[l] : ""}</p>
						</div>
						<button type="button" class="sheet__close" onClick={() => (openSource.value = null)}>
							<span aria-hidden="true">✕</span>
							<span class="sr-only">{t("Cerrar", "Close")}</span>
						</button>
					</header>
					<dl class="sheet__facts">
						<dt>{t("Dato válido para", "Data valid for")}</dt>
						<dd>
							{fullStamp(source.observedAt, l)}
							<span class="sheet__age data"> · {ago(now.value - source.observedAt, l)}</span>
						</dd>
						{health?.lastSuccessAt ? (
							<>
								<dt>{t("Consultado por Vigía", "Fetched by Vigía")}</dt>
								<dd>
									{fullStamp(health.lastSuccessAt, l)}
									<span class="sheet__age data"> · {ago(now.value - health.lastSuccessAt, l)}</span>
								</dd>
							</>
						) : null}
						{source.detail ? (
							<>
								<dt>{t("Cómo se obtiene", "How it is obtained")}</dt>
								<dd>{source.detail}</dd>
							</>
						) : null}
						{health ? (
							<>
								<dt>{t("Estado de la fuente", "Feed state")}</dt>
								<dd>
									<StateBadge state={health.state} />
									{health.lastError ? <p class="note">{health.lastError}</p> : null}
								</dd>
							</>
						) : null}
						{meta ? (
							<>
								<dt>{t("Licencia", "Licence")}</dt>
								<dd>
									<a class="link" href={meta.licence.url} target="_blank" rel="noopener noreferrer">
										{meta.licence.name}
									</a>
									<p class="note">{meta.licence.attribution}</p>
								</dd>
							</>
						) : null}
					</dl>
					<div class="sheet__actions">
						{source.url ? (
							<a class="button button--primary" href={source.url} target="_blank" rel="noopener noreferrer">
								{t("Ver el original", "Open the original")} ↗
							</a>
						) : null}
						{meta ? (
							<a class="button" href={meta.homepage} target="_blank" rel="noopener noreferrer">
								{t("Sitio de la fuente", "Source website")} ↗
							</a>
						) : null}
					</div>
				</div>
			) : null}
		</dialog>
	);
}
