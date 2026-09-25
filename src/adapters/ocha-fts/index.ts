import { z } from "zod";
import type { Adapter, Licence, Observation, RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";

/**
 * OCHA's Financial Tracking System (FTS): how much money the humanitarian response plans for Venezuela ask for
 * (requirements) and how much donors have reported giving (funding). Two kinds of plan:
 *
 * - the Humanitarian Response Plan inside Venezuela (codes `HVEN19`…`HVEN26`), one per year;
 * - the Regional Refugee and Migrant Response Plan (RMRP) for Venezuelans in 17 host countries (code `RREG…`),
 *   found in the current year's plan list by name. It covers the host countries, not Venezuela itself.
 *
 * Three requests per run, keyless, on the public HPC API (verified 2026-09-24, 0.4–0.8 s each):
 * `plan/country/VEN` (the HRPs, 30 KB), `plan/year/<Y>` (every plan of the year, ~200 KB, to find the RMRP), and
 * one `fts/flow?planId=a,b,c&groupby=plan` for all their totals at once (7 KB). Measured that day: HRP 2026
 * requirements US$ 931.3 M (revised up from 632.2 M after the June earthquakes), funding US$ 404.3 M.
 *
 * FTS totals are running totals, revised as donors report: `observedAt` is the fetch time ("as reported to FTS
 * on that day"), and each daily read is kept, so the store holds the funding curve. The percentage funded is
 * computed by the panel, never taken from the source.
 *
 * Licence: CC BY-IGO (OCHA FTS datasets on HDX: "Creative Commons Attribution for Intergovernmental
 * Organisations"). Attribution: "OCHA Financial Tracking Service".
 */

export const FTS_LICENCE: Licence = {
	id: "cc-by-igo-ocha-fts",
	name: "CC BY-IGO (OCHA FTS)",
	url: "https://data.humdata.org/dataset/ven-requirements-and-funding-data",
	attribution: "Fuente: OCHA, Financial Tracking Service (fts.unocha.org)",
	commercial: true,
};

const API = "https://api.hpc.tools/v1/public";
export const FTS_HOME = "https://fts.unocha.org/countries/242/summary/2026";
export const planPage = (id: number) => `https://fts.unocha.org/plans/${id}/summary`;

export type PlanKind = "hrp" | "rmrp";

export type PlanFunding = {
	readonly planId: number;
	readonly code: string;
	readonly name: string;
	readonly year: number;
	readonly kind: PlanKind;
	/** Current (revised) requirements, US$. */
	readonly requirementsUsd: number;
	/** Requirements when the plan was launched, US$; null when FTS gives none. */
	readonly originalRequirementsUsd: number | null;
	/** Funding reported to FTS against the plan, US$. */
	readonly fundedUsd: number;
};

const PlanRow = z.object({
	id: z.number().int().positive(),
	planVersion: z.object({
		code: z.string().min(1),
		name: z.string().min(1),
		startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
	}),
});
const PlanList = z.object({ data: z.array(z.unknown()) });

const Flow = z.object({
	data: z.object({
		requirements: z
			.object({
				objects: z.array(
					z.object({
						id: z.number().int(),
						origRequirements: z.number().nonnegative().optional(),
						revisedRequirements: z.number().nonnegative().optional(),
					}),
				),
			})
			.nullable()
			.optional(),
		report3: z.object({
			fundingTotals: z.object({
				objects: z.array(
					z.object({
						singleFundingObjects: z
							.array(z.object({ id: z.union([z.number(), z.string()]), totalFunding: z.number() }))
							.optional(),
					}),
				),
			}),
		}),
	}),
});

type PlanMeta = { id: number; code: string; name: string; year: number; kind: PlanKind };

/** HRPs for Venezuela: code HVENyy. */
export function isHrp(code: string): boolean {
	return /^HVEN\d{2}$/.test(code);
}

/** The regional plan for Venezuelan refugees and migrants: a regional code (R…) named after Venezuela and the RMRP. */
export function isRmrp(code: string, name: string): boolean {
	return /^R/.test(code) && /venezuela/i.test(name) && /(RMRP|refugee and migrant)/i.test(name);
}

function parseJson(raw: RawResponse, what: string): unknown {
	try {
		return JSON.parse(raw.body);
	} catch {
		throw new SchemaError(`FTS: ${what} no es JSON`);
	}
}

/** The plans named in a plan list, keeping HRPs (and, if asked, the RMRP). Malformed rows are skipped. */
export function plansFrom(body: unknown, withRmrp: boolean): PlanMeta[] {
	const list = PlanList.safeParse(body);
	if (!list.success) throw new SchemaError("FTS: la lista de planes no tiene la forma esperada");
	const out: PlanMeta[] = [];
	for (const row of list.data.data) {
		const p = PlanRow.safeParse(row);
		if (!p.success) continue;
		const { code, name, startDate } = p.data.planVersion;
		const year = Number(startDate.slice(0, 4));
		if (isHrp(code)) out.push({ id: p.data.id, code, name, year, kind: "hrp" });
		else if (withRmrp && isRmrp(code, name)) out.push({ id: p.data.id, code, name, year, kind: "rmrp" });
	}
	return out;
}

function caracasYear(ms: number): number {
	return new Date(ms - 4 * 3_600_000).getUTCFullYear();
}

export const ochaFts: Adapter<PlanFunding> = {
	id: "ocha-fts",
	layer: "society",
	name: {
		es: "Financiamiento de los planes de respuesta humanitaria (OCHA FTS)",
		en: "Humanitarian response plan funding (OCHA FTS)",
	},
	provider: "OCHA Financial Tracking Service",
	homepage: FTS_HOME,
	licence: FTS_LICENCE,
	keys: [],
	// Donors report daily at most; one run a day (three requests, ~240 KB).
	intervalMs: 24 * 3_600_000,
	// observedAt is the read time: the data is as old as the last successful run. Stale after 3 days without one.
	freshness: { fetchMs: 3 * 86_400_000, dataMs: 3 * 86_400_000 },

	async fetch(ctx) {
		const opts = {
			headers: { accept: "application/json" },
			hostGapMs: 1_500,
			maxBytes: 4 * 1024 * 1024,
			signal: ctx.signal,
		};
		const country = await ctx.http.request(`${API}/plan/country/VEN`, opts);
		const year = await ctx.http.request(`${API}/plan/year/${caracasYear(ctx.now())}`, opts);
		const ids = [
			...plansFrom(parseJson(country, "plan/country"), false),
			...plansFrom(parseJson(year, "plan/year"), true).filter((p) => p.kind === "rmrp"),
		].map((p) => p.id);
		if (ids.length === 0) throw new SchemaError("FTS: no se encontró ningún plan para Venezuela");
		const flow = await ctx.http.request(`${API}/fts/flow?planId=${ids.join(",")}&groupby=plan`, opts);
		return [country, year, flow];
	},

	normalise(raws) {
		const country = raws.find((r) => r.url.includes("/plan/country/"));
		const year = raws.find((r) => r.url.includes("/plan/year/"));
		const flow = raws.find((r) => r.url.includes("/fts/flow"));
		if (!country || !flow) throw new SchemaError("FTS: faltan respuestas (planes o flujos)");
		const plans = new Map<number, PlanMeta>();
		for (const p of plansFrom(parseJson(country, "plan/country"), false)) plans.set(p.id, p);
		if (year) {
			for (const p of plansFrom(parseJson(year, "plan/year"), true)) {
				if (p.kind === "rmrp") plans.set(p.id, p);
			}
		}
		const parsed = Flow.safeParse(parseJson(flow, "fts/flow"));
		if (!parsed.success) throw new SchemaError("FTS: la respuesta de flujos no tiene la forma esperada");
		const funded = new Map<number, number>();
		for (const o of parsed.data.data.report3.fundingTotals.objects) {
			for (const s of o.singleFundingObjects ?? []) funded.set(Number(s.id), s.totalFunding);
		}
		const out: Observation<PlanFunding>[] = [];
		for (const r of parsed.data.data.requirements?.objects ?? []) {
			const plan = plans.get(r.id);
			const requirementsUsd = r.revisedRequirements ?? r.origRequirements;
			if (!plan || requirementsUsd === undefined) continue;
			out.push({
				source: "ocha-fts",
				series: `plan:${plan.code}`,
				sourceUrl: planPage(plan.id),
				fetchedAt: flow.fetchedAt,
				observedAt: flow.fetchedAt,
				licence: FTS_LICENCE.id,
				value: {
					planId: plan.id,
					code: plan.code,
					name: plan.name,
					year: plan.year,
					kind: plan.kind,
					requirementsUsd,
					originalRequirementsUsd: r.origRequirements ?? null,
					// A plan with requirements and no reported funding has funding 0, not "unknown".
					fundedUsd: funded.get(r.id) ?? 0,
				},
				confidence: 1,
				basis: "official",
			});
		}
		if (out.length === 0) throw new SchemaError("FTS: ningún plan con requisitos en la respuesta");
		return out;
	},
};
