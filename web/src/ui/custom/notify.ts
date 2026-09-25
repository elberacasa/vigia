import { signal } from "@preact/signals";
import { type AlertItem, read, write } from "../../lib/alerts.ts";
import { lang } from "../../lib/i18n.ts";
import { isPanelId, reveal } from "../../lib/layout.ts";

/**
 * Browser notifications for alerts (lazy: loaded with the alert toasts or the Alerts tab). Opt-in per device, asked
 * only from a click, shown only while Vigía is open in this browser and not in view (the toast covers the rest).
 */

const NOTIFY_KEY = "vigia:alerts-notify";

export type NotifyState = "on" | "off" | "denied" | "unsupported";
function notifyState(): NotifyState {
	if (typeof Notification === "undefined") return "unsupported";
	if (Notification.permission === "denied") return "denied";
	return read(NOTIFY_KEY) === "on" && Notification.permission === "granted" ? "on" : "off";
}
export const notifications = signal<NotifyState>(notifyState());

/** Asks the browser for permission (only from a click) and remembers the choice on this device. */
export async function setNotifications(on: boolean): Promise<NotifyState> {
	if (typeof Notification !== "undefined") {
		if (!on) write(NOTIFY_KEY, "off");
		else {
			const permission =
				Notification.permission === "default"
					? await Notification.requestPermission()
					: Notification.permission;
			write(NOTIFY_KEY, permission === "granted" ? "on" : "off");
		}
	}
	notifications.value = notifyState();
	return notifications.value;
}

const pick = (a: AlertItem) => (lang.value === "en" ? a.title.en : a.title.es);

export async function notify(a: AlertItem): Promise<void> {
	if (notifications.value !== "on" || document.visibilityState === "visible") return;
	const title = pick(a);
	const body = `${lang.value === "en" ? a.detail.en : a.detail.es}\n${a.source}`;
	const options: NotificationOptions = {
		body,
		tag: a.id,
		icon: "/icons/icon-180.png",
		data: { url: `/#${a.panel}` },
	};
	try {
		// Android Chrome only shows notifications through the service worker; desktop browsers take either.
		const reg = await navigator.serviceWorker?.getRegistration();
		if (reg) {
			await reg.showNotification(title, options);
			return;
		}
		const n = new Notification(title, options);
		n.onclick = () => {
			window.focus();
			if (isPanelId(a.panel)) reveal(a.panel);
			n.close();
		};
	} catch {
		// Notifications failed (blocked, unsupported): the in-page toast and the log still have it.
	}
}
