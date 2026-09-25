import { expect, test } from "bun:test";
import { localArchive, verifyBundle } from "../intel/bundle.ts";
import { sealDays } from "../intel/chain.ts";
import { intelSetup } from "./intel-fixture.ts";

test("GET /api/incidents lists incidents with their rules; ?id= gives one with its archived revisions", async () => {
	const { get } = intelSetup();
	const res = await get("/api/incidents");
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		incidents: { id: string; title: { es: string } }[];
		rules: { es: string[] };
	};
	expect(body.incidents.map((i) => i.title.es)).toEqual(["Posible apagón en Zulia"]);
	expect(body.rules.es.length).toBeGreaterThan(5);
	const id = body.incidents[0]?.id ?? "";
	const one = (await (await get(`/api/incidents?id=${encodeURIComponent(id)}`)).json()) as {
		incident: { id: string };
		history: unknown[];
	};
	expect(one.incident.id).toBe(id);
	expect(one.history).toHaveLength(1);
	expect((await get("/api/incidents?id=nope")).status).toBe(404);
	expect((await get("/api/incidents?id=%3Cscript%3E")).status).toBe(400);
});

test("GET /api/archive/digests exposes hashes only; GET /api/evidence downloads a bundle that verifies", async () => {
	const { get, store } = intelSetup();
	await get("/api/incidents");
	// Seal the day the headlines were received (24 Sept), as the server does an hour after midnight UTC.
	sealDays(store, Date.UTC(2026, 8, 26, 2));
	const digests = (await (await get("/api/archive/digests")).json()) as { entries: { day: string }[] };
	expect(digests.entries.map((e) => e.day)).toEqual(["2026-09-24", "2026-09-25"]);
	expect(JSON.stringify(digests)).not.toContain("Maracaibo");
	expect((await get("/api/archive/digests?from=ayer")).status).toBe(400);

	const list = (await (await get("/api/incidents")).json()) as { incidents: { id: string }[] };
	const id = list.incidents[0]?.id ?? "";
	const res = await get(`/api/evidence?incident=${encodeURIComponent(id)}`, "10.0.0.9");
	expect(res.status).toBe(200);
	expect(res.headers.get("content-disposition")).toMatch(
		/^attachment; filename="vigia-evidencia-incidente-VE-V-/,
	);
	const bundle = await res.json();
	const report = verifyBundle(bundle, localArchive(store));
	expect(report.ok).toBe(true);
	// Two headlines (24 Sept) and the incident's own archived revision (25 Sept), all sealed.
	expect(report.proven).toBe(3);

	const panel = await get("/api/evidence?panel=incidents", "10.0.0.9");
	expect(panel.status).toBe(200);
	expect((await get("/api/evidence?panel=nope", "10.0.0.9")).status).toBe(404);
	expect((await get("/api/evidence", "10.0.0.9")).status).toBe(400);
});

test("evidence downloads have their own tighter rate limit", async () => {
	const { get } = intelSetup();
	const codes: number[] = [];
	for (let i = 0; i < 8; i++) codes.push((await get("/api/evidence?panel=incidents", "10.0.0.77")).status);
	expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
});
