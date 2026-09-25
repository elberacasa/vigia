import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { healthById, now } from "../../lib/data.ts";
import { ago, fullStamp, int } from "../../lib/format.ts";
import { lang, t } from "../../lib/i18n.ts";
import { href } from "../../lib/router.ts";
import { StateBadge } from "../Source.tsx";
import {
	categoryLabel,
	countryLabel,
	kindLabel,
	langLabel,
	panelLabel,
	regionLabel,
	stanceLabel,
} from "./labels.ts";
import type { Row } from "./model.ts";
import { openFeed } from "./state.ts";
import { every, span } from "./time.ts";

/** Everything Vigía knows about one feed: health, budget, licence, what it feeds, when it joined. */
export function FeedSheet({ row }: { row: Row }) {
	const l = lang.value;
	const m = row.meta;
	const h = healthById.value.get(row.id);
	const ref = useRef<HTMLDivElement>(null);
	const close = () => {
		openFeed.value = null;
	};
	useEffect(() => {
		const opener = document.activeElement as HTMLElement | null;
		ref.current?.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
		};
		addEventListener("keydown", onKey);
		return () => {
			removeEventListener("keydown", onKey);
			opener?.focus?.();
		};
	}, [row.id]);
	const n = now.value;
	const facts: [string, ComponentChildren][] = [
		[t("Publica", "Publisher"), m.provider + (m.stance ? ` · ${stanceLabel(m.stance, l)}` : "")],
		[t("Categoría", "Category"), row.category.map((c) => categoryLabel(c, l)).join(" · ")],
		[t("Tipo", "Type"), kindLabel(row.kind, l)],
		[
			t("Región", "Region"),
			regionLabel(row.region, l) + (row.country !== "VE" ? ` · ${countryLabel(row.country, l)}` : ""),
		],
		[t("Idioma", "Language"), langLabel(row.lang, l)],
		[
			t("Frecuencia", "Interval"),
			`${every(m.intervalMs, l)} · ${t("con retraso si no responde en", "delayed if silent for")} ${span(m.freshness.fetchMs, l)}${
				m.freshness.dataMs !== null
					? t(
							` o su dato pasa de ${span(m.freshness.dataMs, l)}`,
							` or its datum is older than ${span(m.freshness.dataMs, l)}`,
						)
					: ""
			}`,
		],
		[
			t("Alimenta", "Feeds"),
			(m.panels ?? []).length ? (m.panels ?? []).map((p) => panelLabel(p, l)).join(" · ") : "—",
		],
		[
			t("En Vigía desde", "In Vigía since"),
			row.added
				? `${fullStamp(row.added, l)}${m.addedBy === "run" ? t(" (primera consulta en este equipo)", " (first poll on this machine)") : ""}`
				: "—",
		],
	];
	return (
		<div class="fsheet">
			<button
				type="button"
				class="fsheet__scrim"
				tabIndex={-1}
				aria-label={t("Cerrar", "Close")}
				onClick={close}
			/>
			<div
				class="fsheet__card"
				role="dialog"
				aria-modal="true"
				aria-labelledby="fsheet-title"
				tabIndex={-1}
				ref={ref}
			>
				<header class="fsheet__head">
					<div>
						<p class="caps fsheet__kicker">{categoryLabel(row.primary, l)}</p>
						<h2 id="fsheet-title" class="fsheet__title">
							{m.name[l]}
						</h2>
					</div>
					<button type="button" class="fsheet__close" onClick={close} aria-label={t("Cerrar", "Close")}>
						<svg viewBox="0 0 16 16" aria-hidden="true">
							<path d="M4 4l8 8M12 4l-8 8" />
						</svg>
					</button>
				</header>
				<div class="fsheet__health">
					{h ? <StateBadge state={h.state} /> : null}
					<span class="mono">
						{t("dato", "datum")} {h?.newestObservedAt ? ago(n - h.newestObservedAt, l) : "—"}
					</span>
					<span class="mono">
						{t("consulta", "poll")} {h?.lastSuccessAt ? ago(n - h.lastSuccessAt, l) : "—"}
					</span>
					{h?.successRate !== null && h?.successRate !== undefined ? (
						<span class="mono">
							{int(h.successRate * 100, l)} % {t("éxito", "success")}
						</span>
					) : null}
				</div>
				{h?.lastError && h.state !== "ok" ? <p class="fsheet__error mono">{h.lastError}</p> : null}
				<dl class="fsheet__facts">
					{facts.map(([k, v]) => (
						<div key={k}>
							<dt>{k}</dt>
							<dd>{v}</dd>
						</div>
					))}
					<div>
						<dt>{t("Licencia", "Licence")}</dt>
						<dd>
							<a class="link" href={m.licence.url} target="_blank" rel="noopener noreferrer">
								{m.licence.name}
							</a>
							<span class="note"> · {m.licence.attribution}</span>
						</dd>
					</div>
				</dl>
				{m.keys.length || m.optIn || m.note ? (
					<p class="fsheet__key">
						{m.keys.length
							? t("Esta fuente necesita una clave gratuita.", "This source needs a free key.")
							: (m.optIn ?? m.note)?.[l]}{" "}
						{m.note && !m.optIn && !m.keys.length
							? t("Puedes apagarla en la guía.", "You can turn it off in the guide.")
							: null}{" "}
						<a class="link" href={`${href("guide")}${m.keys[0] ? `#key-${m.keys[0]}` : ""}`}>
							{t("Ver la guía", "Open the guide")}
						</a>
					</p>
				) : null}
				<footer class="fsheet__foot">
					<a class="fsheet__btn" href={m.homepage} target="_blank" rel="noopener noreferrer">
						{t("Abrir la fuente original", "Open the original source")} ↗
					</a>
					<span class="note mono">{row.id}</span>
				</footer>
			</div>
		</div>
	);
}
