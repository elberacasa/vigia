import type { AlertService } from "../alerts/service.ts";
import type { UserFeeds } from "../userfeeds/service.ts";
import { RateLimiter } from "./ratelimit.ts";

/**
 * The personalisation API: the user's own feeds ("Mis fuentes") and alert rules ("Mis alertas").
 *
 *   GET    /api/user-feeds            the list
 *   POST   /api/user-feeds            add one {url, name?, region?, intervalMin?}: checked, fetched once, parsed
 *   PATCH  /api/user-feeds/:id        change name, region or interval
 *   DELETE /api/user-feeds/:id        stop following it
 *   GET    /api/alerts                rules, each rule's current status, and the alert log
 *   PUT    /api/alerts/rules          replace the rule list {rules: [...]}
 *   DELETE /api/alerts/log            clear the log
 *
 * Reads are open like every other read. Writes go through the same guard as keys and settings (loopback, loopback
 * Host, same Origin, JSON, and the session cookie), then a rate limit; adding a feed has its own, slower limit
 * because each add makes one outbound request.
 */

export interface CustomDeps {
	readonly userFeeds?: UserFeeds | undefined;
	readonly alerts?: AlertService | undefined;
}

type Json = (data: unknown, status?: number) => Response;

export interface CustomContext {
	readonly request: Request;
	readonly path: string;
	readonly method: string;
	readonly ip: string;
	/** The app's write guard: a refusal, or null when the write may proceed. */
	readonly allowWrite: () => Response | null;
	/** Whether this request may read the user's own feeds and alerts (always on loopback; see app.ts privateOk). */
	readonly privateOk: boolean;
	/** The app's shared write limiter (10 at once, then one per 5 s per client). */
	readonly takeWrite: () => boolean;
	readonly now: number;
	readonly json: Json;
}

const MAX_BODY_BYTES = 64 * 1024;
const PRIVATE = "Tus fuentes y alertas solo se ven desde el navegador abierto con el enlace de la terminal.";

async function readJson(request: Request): Promise<unknown> {
	// Refuse a large body before reading it (the declared length), and again if it was not declared.
	if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return undefined;
	const text = await request.text().catch(() => "");
	if (text.length > MAX_BODY_BYTES) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

export function customRoutes(deps: CustomDeps, now: () => number = Date.now) {
	// One feed test-fetch per client every 10 s after a burst of 3; 30 per minute for everyone together.
	const addLimiter = new RateLimiter(3, 0.1, now);
	const addGlobal = new RateLimiter(30, 0.5, now);

	/** Returns the response for a personalisation route, or null when the path is not one. */
	return async (c: CustomContext): Promise<Response | null> => {
		const { path, method, json } = c;
		const refuse = (status: number, error: string) => json({ error }, status);
		const guarded = (): Response | null => {
			const refusal = c.allowWrite();
			if (refusal) return refusal;
			if (!c.takeWrite()) return refuse(429, "Demasiados intentos. Espera un minuto.");
			return null;
		};

		if (path === "/api/user-feeds" || path.startsWith("/api/user-feeds/")) {
			const feeds = deps.userFeeds;
			if (!feeds) return refuse(404, "Ruta desconocida.");
			if (method === "GET" && !c.privateOk) return refuse(403, PRIVATE);
			if (path === "/api/user-feeds" && method === "GET") return json({ now: c.now, feeds: feeds.list() });
			if (path === "/api/user-feeds" && method === "POST") {
				const refusal = guarded();
				if (refusal) return refusal;
				if (!addLimiter.take(c.ip) || !addGlobal.take("all"))
					return refuse(429, "Espera unos segundos antes de añadir otra fuente.");
				const body = await readJson(c.request);
				if (body === undefined) return refuse(400, "Se espera JSON.");
				const result = await feeds.add(body, c.request.signal);
				return result.ok
					? json({ ok: true, feed: result.feed, preview: result.preview }, 201)
					: json({ ok: false, error: result.reason }, result.status);
			}
			const one = /^\/api\/user-feeds\/(mia-[0-9a-f]{10})$/.exec(path);
			if (one?.[1] && (method === "PATCH" || method === "DELETE")) {
				const refusal = guarded();
				if (refusal) return refusal;
				if (method === "DELETE")
					return feeds.remove(one[1]) ? json({ ok: true }) : refuse(404, "Fuente desconocida.");
				const body = await readJson(c.request);
				if (body === undefined) return refuse(400, "Se espera JSON.");
				const result = feeds.update(one[1], body);
				return result.ok
					? json({ ok: true, feed: result.feed })
					: json({ ok: false, error: result.reason }, result.status);
			}
			return refuse(
				method === "GET" ? 404 : 405,
				method === "GET" ? "Ruta desconocida." : "Método no permitido.",
			);
		}

		if (path === "/api/alerts" || path.startsWith("/api/alerts/")) {
			const alerts = deps.alerts;
			if (!alerts) return refuse(404, "Ruta desconocida.");
			if (method === "GET" && !c.privateOk) return refuse(403, PRIVATE);
			if (path === "/api/alerts" && method === "GET") {
				// ?since=<ms>: the page's light first-load check (rule count and what fired since it last looked).
				const since = Number(new URL(c.request.url).searchParams.get("since") ?? Number.NaN);
				if (Number.isFinite(since)) {
					const view = alerts.view();
					return json({
						now: view.now,
						ruleCount: view.rules.length,
						log: view.log.filter((a) => a.at > since).slice(0, 50),
					});
				}
				return json(alerts.view());
			}
			if (path === "/api/alerts/rules" && method === "PUT") {
				const refusal = guarded();
				if (refusal) return refusal;
				const body = await readJson(c.request);
				const rules =
					body && typeof body === "object" && "rules" in body
						? (body as { rules: unknown }).rules
						: undefined;
				if (rules === undefined) return refuse(400, 'Se espera {"rules": [...]}.');
				const result = alerts.setRules(rules);
				return result.ok
					? json({ ok: true, ...alerts.view() })
					: json({ ok: false, error: result.reason }, 400);
			}
			if (path === "/api/alerts/log" && method === "DELETE") {
				const refusal = guarded();
				if (refusal) return refusal;
				alerts.clearLog();
				return json({ ok: true });
			}
			return refuse(
				method === "GET" ? 404 : 405,
				method === "GET" ? "Ruta desconocida." : "Método no permitido.",
			);
		}

		return null;
	};
}
