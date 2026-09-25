import "./style.ts";
import { useEffect, useRef } from "preact/hooks";
import { markAlertsRead, unreadAlerts } from "../../lib/alerts.ts";
import { t } from "../../lib/i18n.ts";
import { AlertsTab } from "./AlertsTab.tsx";
import { type CustomTab, closeCustomize, customizeTab } from "./open.ts";
import { PanelsTab } from "./PanelsTab.tsx";
import { SourcesTab } from "./SourcesTab.tsx";
import { ViewsTab } from "./ViewsTab.tsx";

/**
 * "Personalizar": one sheet for everything the reader can make their own, in four tabs. Views and panel settings
 * live on this device; the reader's own feeds and alert rules live on this Vigía (the server), and changing them
 * needs the session the terminal link opens.
 */

const TABS: { id: CustomTab; es: string; en: string }[] = [
	{ id: "views", es: "Vistas", en: "Views" },
	{ id: "panels", es: "Paneles", en: "Panels" },
	{ id: "sources", es: "Mis fuentes", en: "My sources" },
	{ id: "alerts", es: "Alertas", en: "Alerts" },
];

export function CustomizeSheet() {
	const ref = useRef<HTMLDialogElement>(null);
	const tab = customizeTab.value;
	useEffect(() => {
		const d = ref.current;
		if (!d) return;
		if (tab && !d.open) {
			d.showModal();
			// Start on the sheet itself (screen readers read its title), not on the close button with its ring.
			d.focus();
		}
		if (!tab && d.open) d.close();
	}, [tab]);
	useEffect(() => {
		if (tab === "alerts") markAlertsRead();
	}, [tab]);
	const unread = unreadAlerts.value.length;
	const close = closeCustomize;
	const onKey = (e: KeyboardEvent) => {
		const i = TABS.findIndex((x) => x.id === tab);
		const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
		if (!step || i === -1) return;
		e.preventDefault();
		const next = TABS[(i + step + TABS.length) % TABS.length];
		if (!next) return;
		customizeTab.value = next.id;
		requestAnimationFrame(() => document.getElementById(`custom-tab-${next.id}`)?.focus());
	};
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; Escape closes the dialog natively.
		<dialog
			ref={ref}
			class="sheet sheet--custom"
			tabIndex={-1}
			aria-labelledby="custom-title"
			onClose={close}
			onClick={(e) => {
				if (e.target === ref.current) close();
			}}
		>
			{tab ? (
				<div class="custom">
					<header class="custom__head">
						<div>
							<p class="caps sheet__kicker">{t("Hazlo tuyo", "Make it yours")}</p>
							<h2 id="custom-title" class="sheet__title">
								{t("Personalizar", "Customise")}
							</h2>
						</div>
						<button type="button" class="sheet__close" onClick={close}>
							<span aria-hidden="true">✕</span>
							<span class="sr-only">{t("Cerrar", "Close")}</span>
						</button>
					</header>
					<div class="custom__tabs" role="tablist" aria-label={t("Secciones", "Sections")} onKeyDown={onKey}>
						{TABS.map((x) => (
							<button
								type="button"
								role="tab"
								key={x.id}
								id={`custom-tab-${x.id}`}
								aria-selected={tab === x.id}
								aria-controls="custom-panel"
								tabIndex={tab === x.id ? 0 : -1}
								onClick={() => {
									customizeTab.value = x.id;
								}}
							>
								{t(x.es, x.en)}
								{x.id === "alerts" && unread && tab !== "alerts" ? (
									<span class="custom-open__badge data">{unread > 9 ? "9+" : unread}</span>
								) : null}
							</button>
						))}
					</div>
					<div class="custom__body" id="custom-panel" role="tabpanel" aria-labelledby={`custom-tab-${tab}`}>
						{tab === "views" ? (
							<ViewsTab />
						) : tab === "panels" ? (
							<PanelsTab />
						) : tab === "sources" ? (
							<SourcesTab />
						) : (
							<AlertsTab />
						)}
					</div>
				</div>
			) : null}
		</dialog>
	);
}
