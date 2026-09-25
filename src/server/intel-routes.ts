/**
 * Routes for the intelligence layer (incidents, evidence bundles, the archive's hash chain, the terminal report).
 * Kept out of app.ts so the shared router only gains one line per route.
 */

import type { FeedHealth } from "../core/health.ts";
import type { Store } from "../core/store.ts";
import type { Json } from "../core/types.ts";
import { INCIDENTS_SOURCE, incidentHistory } from "../intel/archive.ts";
import { buildBundle, latestRows, resolveRef } from "../intel/bundle.ts";
import { type ArchivedRow, CHAIN_FORMAT, chain } from "../intel/chain.ts";
import { renderReport, TERMINAL_PANELS } from "../intel/terminal.ts";
import type { IncidentsView } from "../panels/incidents.ts";
import { json, problem } from "./app.ts";
import type { PanelCache } from "./panels.ts";
import { RateLimiter } from "./ratelimit.ts";
import type { Visibility } from "./visibility.ts";

export interface IntelDeps {
	readonly store: Store;
	readonly panels: PanelCache;
	readonly version: string;
}

const HOUR = 3_600_000;
const ID = /^[\w:.+-]{1,200}$/;

/** GET /api/incidents: the current listing; ?id=… one incident with every archived revision (its timeline). */
export function incidentsRoute(deps: IntelDeps, url: URL, now: number): Response {
	const view = deps.panels.get("incidents") as IncidentsView | undefined;
	if (!view) return problem(503, "Los incidentes no están disponibles ahora.");
	const id = url.searchParams.get("id");
	if (id === null) {
		return json({
			now,
			asOf: view.asOf,
			counts: view.counts,
			incidents: view.incidents,
			rules: view.rules,
		});
	}
	if (!ID.test(id)) return problem(400, "Identificador no válido.");
	const history = incidentHistory(deps.store, id, now);
	const listed = view.incidents.find((i) => i.id === id) ?? null;
	if (!listed && history.length === 0) return problem(404, "Incidente desconocido.");
	// The timeline: one compact line per archived revision (the full incident is `incident`).
	const revisions = history.map((i) => ({
		lastEvidenceAt: i.lastEvidenceAt,
		startAt: i.startAt,
		families: i.families,
		corroboration: i.corroboration,
		reportsOnly: i.reportsOnly,
		evidenceTotal: i.evidenceTotal,
		evidence: i.evidence.map((e) => e.id),
	}));
	return json({ now, incident: listed ?? history.at(-1) ?? null, history: revisions, rules: view.rules });
}

/** GET /api/archive/digests?from=YYYY-MM-DD&to=YYYY-MM-DD: the sealed chain (hashes only, never data). */
export function digestsRoute(deps: IntelDeps, url: URL, now: number): Response {
	const day = /^\d{4}-\d{2}-\d{2}$/;
	const from = url.searchParams.get("from") ?? "0000-00-00";
	const to = url.searchParams.get("to") ?? "9999-99-99";
	if ((url.searchParams.has("from") && !day.test(from)) || (url.searchParams.has("to") && !day.test(to)))
		return problem(400, "Fechas en formato AAAA-MM-DD.");
	const entries = chain(deps.store, from, to);
	return json({
		now,
		format: CHAIN_FORMAT,
		method:
			"Cada día UTC de observaciones recibidas se sella en un árbol de Merkle (SHA-256) y se encadena al día anterior. Compruébelo con: vigia verify",
		head: entries.at(-1) ?? null,
		entries,
	});
}

const evidenceLimiter = new RateLimiter(6, 0.1);
/** All clients together: each bundle may hash whole days, so the server builds at most ~6 a minute. */
const evidenceGlobal = new RateLimiter(10, 0.1);
/** A bundle carries the incident's newest revisions, not all of them. */
const MAX_REVISIONS = 20;

/**
 * GET /api/evidence?incident=<id> or ?panel=<id>: an evidence bundle to keep (downloaded as a file). Heavier than
 * other reads (it hashes the whole day to build each proof), so it has its own, tighter limit. Only panels and
 * rows `visible` allows: the user's own feeds never go into a bundle for a request that may not see them.
 */
export function evidenceRoute(
	deps: IntelDeps,
	url: URL,
	now: number,
	ip: string,
	visible: Visibility,
): Response {
	const incidentId = url.searchParams.get("incident");
	const panelId = url.searchParams.get("panel");
	// A panel this request may not see is unknown to it, before any limit is charged.
	if (
		incidentId === null &&
		panelId !== null &&
		!visible.panels(deps.panels.panels).some((p) => p.id === panelId)
	)
		return problem(404, "Panel desconocido.");
	if (!evidenceLimiter.take(ip) || !evidenceGlobal.take("all"))
		return problem(429, "Demasiadas descargas de evidencia. Espera un minuto.");
	let bundle: ReturnType<typeof buildBundle>;
	let name: string;
	if (incidentId !== null) {
		if (!ID.test(incidentId)) return problem(400, "Identificador no válido.");
		const view = deps.panels.get("incidents") as IncidentsView | undefined;
		const history = incidentHistory(deps.store, incidentId, now);
		const incident = view?.incidents.find((i) => i.id === incidentId) ?? history.at(-1);
		if (!incident) return problem(404, "Incidente desconocido.");
		const refs = [...incident.evidence, ...incident.context].flatMap((e) => e.refs);
		const rows: ArchivedRow[] = [];
		for (const ref of refs) {
			const row = visible.source(ref.source) ? resolveRef(deps.store, ref, now) : null;
			if (row) rows.push(row);
		}
		// The incident's own archived revisions are observations too: they prove what Vigía showed, and when.
		for (const revision of deps.store
			.history<Json>(INCIDENTS_SOURCE, `incident:${incidentId}`, 0, now, 5_000)
			.slice(-MAX_REVISIONS)) {
			const row = resolveRef(
				deps.store,
				{ source: INCIDENTS_SOURCE, series: revision.series, observedAt: revision.observedAt },
				now,
			);
			if (row) rows.push(row);
		}
		bundle = buildBundle(
			deps.store,
			{
				subject: { kind: "incident", id: incident.id, title: incident.title.es },
				rows,
				snapshot: incident as unknown as Json,
				rules: view?.rules ?? { es: [], en: [] },
				generator: `Vigía ${deps.version}`,
			},
			now,
		);
		name = `incidente-${incident.state ?? incident.kind}`;
	} else if (panelId !== null) {
		const panel = visible.panels(deps.panels.panels).find((p) => p.id === panelId);
		const snapshot = panel ? deps.panels.get(panel.id) : undefined;
		if (!panel || snapshot === undefined) return problem(404, "Panel desconocido.");
		bundle = buildBundle(
			deps.store,
			{
				subject: { kind: "panel", id: panel.id, title: panel.id },
				rows: latestRows(deps.store, panel.sources.filter(visible.source), now - 48 * HOUR),
				snapshot,
				rules: {
					es: [
						"Instantánea del panel tal como la calculó Vigía, con la observación más reciente de cada serie de sus fuentes en las últimas 48 h (máximo 300).",
					],
					en: [
						"Snapshot of the panel as Vigía computed it, with the newest observation of each series of its sources in the last 48 h (at most 300).",
					],
				},
				generator: `Vigía ${deps.version}`,
			},
			now,
		);
		name = `panel-${panel.id}`;
	} else return problem(400, "Indica ?incident=<id> o ?panel=<id>.");
	const stamp = new Date(now).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
	return json(bundle, 200, {
		"content-disposition": `attachment; filename="vigia-evidencia-${name.replace(/[^\w-]/g, "")}-${stamp}.json"`,
	});
}

/** curl, wget and friends get the text report on "/" (wttr.in style); browsers get the page. */
export function wantsText(request: Request): boolean {
	return /^(curl|wget|httpie|xh)\//i.test(request.headers.get("user-agent") ?? "");
}

/** GET /ahora.txt (and "/" for curl/wget): the situation in plain text, 80 columns; ?color=1, ?lang=en. */
export function terminalRoute(
	deps: IntelDeps,
	url: URL,
	now: number,
	health: readonly Pick<FeedHealth, "id" | "state" | "lastSuccessAt">[],
): Response {
	const text = renderReport({
		panels: deps.panels.all(new Set(TERMINAL_PANELS)),
		health,
		now,
		lang: url.searchParams.get("lang") === "en" ? "en" : "es",
		color: /^(1|true|si|sí|yes)$/i.test(url.searchParams.get("color") ?? ""),
		origin: url.origin,
	});
	return new Response(text, {
		headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", vary: "user-agent" },
	});
}
