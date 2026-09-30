import { expect, test } from "bun:test";
import { Store } from "../core/store.ts";
import type { Observation } from "../core/types.ts";
import { sealDays, verifyChain } from "../intel/chain.ts";
import { purgeStoredNews } from "./purge.ts";

const DAY = 86_400_000;

/** A news item as versions before the review of 29 Sept 2026 stored it (names altered; the forms are not). */
function item(id: string, title: string, summary: string, fetchedAt: number): Observation {
	return {
		source: "nuevo-dia",
		series: `item:${id}`,
		sourceUrl: `https://example.org/${id}`,
		fetchedAt,
		observedAt: fetchedAt - 3_600_000,
		licence: "headline",
		value: {
			outlet: "nuevo-dia",
			title,
			link: `https://example.org/${id}`,
			summary,
			image: null,
			dateMissing: false,
			video: false,
		},
		confidence: 1,
		basis: "report",
	};
}

const text = (store: Store) => JSON.stringify(store.db.query("SELECT value FROM obs").all());

test("stored court notices are removed and identity numbers stripped; sealed days still verify", () => {
	const store = new Store(":memory:");
	const sealedAt = Date.UTC(2026, 8, 20, 12);
	const now = Date.UTC(2026, 8, 29, 12);
	store.insert([
		item(
			"a",
			"Edicto.Nombre Apellido Delacruz.",
			"cédula de identidad V-24.143.763, representando a su hija",
			sealedAt,
		),
		item("b", "Detenido en Maturín un hombre con cédula V-12.345.678", "Según la policía regional", sealedAt),
		item("c", "Liquidez de Bs 2.839.145 millones", "El BCV publicó sus cifras", sealedAt),
		item("d", "Cartel de Citación a los ciudadanos Nombre Apellido", "", now - 3_600_000),
	]);
	sealDays(store, now);
	expect(verifyChain(store).every((d) => d.ok)).toBe(true);

	expect(purgeStoredNews(store, now)).toBe(3);
	const kept = text(store);
	expect(kept).not.toMatch(/Delacruz|24\.143\.763|12\.345\.678|Citaci/u);
	// The label goes with the number ("cédula V-…" as one unit, like the Gaceta rule): clipped, never identifying.
	expect(kept).toContain('"title\\":\\"Detenido en Maturín un hombre con\\"');
	expect(kept).toContain("Bs 2.839.145 millones");
	expect(store.db.query("SELECT count(*) AS n FROM obs").get()).toEqual({ n: 2 });
	// The sealed day lost two rows (one removed, one replaced): both hashes are kept, so it verifies.
	const checks = verifyChain(store);
	expect(checks.every((d) => d.ok)).toBe(true);
	expect(checks.find((d) => d.day === "2026-09-20")?.pruned).toBe(2);
	// Idempotent: a second start changes nothing.
	expect(purgeStoredNews(store, now + DAY)).toBe(0);
});
