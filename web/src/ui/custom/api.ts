import { t } from "../../lib/i18n.ts";

/** Result of a write to the personalisation API, with a reader-facing error. */
export type Sent<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

/**
 * Sends a write. Every write needs the session cookie the terminal link sets (src/config/session.ts); without it the
 * server refuses with code "session", which becomes a plain instruction here.
 */
export async function send<T>(
	method: "POST" | "PUT" | "PATCH" | "DELETE",
	path: string,
	body?: unknown,
): Promise<Sent<T>> {
	let res: Response;
	try {
		res = await fetch(path, {
			method,
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify(body ?? {}),
		});
	} catch {
		return { ok: false, status: 0, error: t("Sin conexión con Vigía.", "No connection to Vigía.") };
	}
	const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
	if (res.ok) return { ok: true, data };
	if (res.status === 403 && data.code === "session")
		return {
			ok: false,
			status: 403,
			error: t(
				"Este navegador no tiene permiso para cambiar ajustes: abre Vigía desde el enlace que muestra la terminal.",
				"This browser may not change settings: open Vigía from the link the terminal prints.",
			),
		};
	return { ok: false, status: res.status, error: data.error ?? t("No se pudo guardar.", "Could not save.") };
}

export async function getJson<T>(path: string): Promise<T | null> {
	try {
		const res = await fetch(path, { headers: { accept: "application/json" } });
		return res.ok ? ((await res.json()) as T) : null;
	} catch {
		return null;
	}
}
