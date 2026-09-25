import { expect, test } from "bun:test";
import type { FeedHealth } from "../../core/health.ts";
import { reportPage } from "./report.ts";

const NOW = Date.UTC(2026, 8, 25, 7);
const HOUR = 3_600_000;
const row = (id: string, state: FeedHealth["state"], lastSuccessAt: number | null): FeedHealth =>
	({ id, state, lastSuccessAt }) as FeedHealth;
const page = (health: FeedHealth[]) =>
	reportPage({
		now: NOW,
		version: "test",
		origin: "http://localhost",
		brief: undefined,
		ai: undefined,
		incidents: { asOf: NOW - 60_000, incidents: [], feeds: ["ioda-states", "ripe-atlas-probes"] },
		health,
		adapters: [],
		usedFeeds: [],
		chainHead: null,
	});

test("review 4 M2: 'Ningún incidente activo' only on live inputs, and the section says how old they are", () => {
	const live = page([
		row("ioda-states", "ok", NOW - 10 * 60_000),
		row("ripe-atlas-probes", "stale", NOW - 9 * HOUR),
	]);
	expect(live).toContain("Ningún incidente activo");
	expect(live).toContain("Señales medidas leídas por última vez hace 10 min.");
	const stale = page([
		row("ioda-states", "stale", NOW - 5 * HOUR),
		row("ripe-atlas-probes", "failing", NOW - 9 * HOUR),
	]);
	expect(stale).not.toContain("Ningún incidente activo");
	expect(stale).toContain("Sin datos recientes para afirmar que no hay incidentes");
	expect(stale).toContain(
		'Señales medidas leídas por última vez hace 5 h <span class="tag tag--stale">atrasadas</span>.',
	);
	expect(page([])).toContain("Sin señales medidas leídas todavía");
});
