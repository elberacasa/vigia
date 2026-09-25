import type { FunctionComponent } from "preact";
import { useEffect, useState } from "preact/hooks";
import { startAlerts, toasts, unreadAlerts } from "../../lib/alerts.ts";
import { t } from "../../lib/i18n.ts";
import { customizeTab, openCustomize } from "./open.ts";

/**
 * The first-load half of "Personalizar" (about 1.5 KB): the header button with its unread-alert badge, the alert
 * toasts, and the loader of the sheet itself, a separate chunk fetched on first use (or when the page is idle).
 */

/** Only http(s) links leave the page; anything else is not a link. */
export function safeHref(url: string): string | undefined {
	return /^https?:\/\//i.test(url) ? url : undefined;
}

let loading: Promise<FunctionComponent> | null = null;
function loadSheet(): Promise<FunctionComponent> {
	loading ??= import("./Customize.tsx").then((m) => m.CustomizeSheet);
	return loading;
}

export function CustomizeButton() {
	const unread = unreadAlerts.value.length;
	useEffect(() => {
		// The alert check is one small request, after the panels have loaded.
		const timer = setTimeout(() => void startAlerts(), 2_500);
		return () => clearTimeout(timer);
	}, []);
	return (
		<button
			type="button"
			class="chip custom-open"
			aria-haspopup="dialog"
			aria-label={
				unread
					? t(`Personalizar · ${unread} alertas nuevas`, `Customise · ${unread} new alerts`)
					: t(
							"Personalizar: vistas, paneles, mis fuentes y alertas",
							"Customise: views, panels, my sources and alerts",
						)
			}
			title={t("Personalizar", "Customise")}
			onClick={() => openCustomize(unread ? "alerts" : "views")}
			onPointerEnter={() => void loadSheet().catch(() => {})}
		>
			<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
				<path
					d="M2 4h7M13 4h1M2 12h1M7 12h7M2 8h3M9 8h5"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
				/>
				<circle cx="11" cy="4" r="1.8" fill="none" stroke="currentColor" stroke-width="1.6" />
				<circle cx="5" cy="12" r="1.8" fill="none" stroke="currentColor" stroke-width="1.6" />
				<circle cx="7" cy="8" r="1.8" fill="none" stroke="currentColor" stroke-width="1.6" />
			</svg>
			<span class="custom-open__label">{t("Personalizar", "Customise")}</span>
			{unread ? (
				<span class="custom-open__badge data" aria-hidden="true">
					{unread > 9 ? "9+" : unread}
				</span>
			) : null}
		</button>
	);
}

/** The alert toasts are their own small chunk, fetched the first time an alert arrives during a visit. */
let loadingToasts: Promise<FunctionComponent> | null = null;
export function AlertToasts() {
	const [Toasts, setToasts] = useState<FunctionComponent | null>(null);
	const any = toasts.value.length > 0;
	useEffect(() => {
		if (!any || Toasts) return;
		loadingToasts ??= import("./Toasts.tsx").then((m) => m.Toasts);
		loadingToasts.then((c) => setToasts(() => c)).catch(() => {});
	}, [any, Toasts]);
	return Toasts ? <Toasts /> : null;
}

export function LazyCustomize() {
	const [Sheet, setSheet] = useState<FunctionComponent | null>(null);
	const open = customizeTab.value !== null;
	useEffect(() => {
		if (!open || Sheet) return;
		loadSheet()
			.then((c) => setSheet(() => c))
			.catch(() => {
				customizeTab.value = null;
			});
	}, [open, Sheet]);
	return Sheet ? <Sheet /> : null;
}
