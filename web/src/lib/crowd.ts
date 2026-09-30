import { signal } from "@preact/signals";

/**
 * "¿Tienes luz?": the little that must be in the first load so the room can offer the report (the sheet, the worker
 * and the words load on demand, ui/crowd/). `GET /api/crowd` is asked once per visit after the first data is on
 * screen; the button appears only when this Vigía takes reports (`enabled`), and says nothing while it is unknown.
 */

export interface CrowdService {
	id: "luz" | "agua" | "internet" | "gasolina";
	es: string;
	en: string;
	question: { es: string; en: string };
}
export interface CrowdAnswer {
	id: "si" | "no" | "intermitente";
	es: string;
	en: string;
}
/** `GET /api/crowd` (src/crowd/routes.ts): what to ask, the rules and exactly what is stored, generated from the code. */
export interface CrowdConfig {
	enabled: boolean;
	mode: "local" | "public";
	services: CrowdService[];
	answers: CrowdAnswer[];
	windowMs: number;
	bucketMs: number;
	minReporters: number;
	publishOpenBucket: boolean;
	limits: { burst: number; perHour: number; maxMunicipalitiesPerDay: number };
	pow: { algorithm: string; difficulty: number; challenge: string };
	submit: string;
	source: { id: string; licenceName: string; licenceUrl: string; attribution: string };
	rules: { es: string[]; en: string[] };
	stored: { es: string[]; en: string[] };
}

export const crowdConfig = signal<CrowdConfig | null>(null);
/** The report sheet: closed (null), or open with the municipality to start from (an entity id, or none). */
export const reportSheet = signal<{ municipality: string | null } | null>(null);

let asked: Promise<CrowdConfig | null> | null = null;

/** The instance's crowd settings, fetched once per visit (a failed read is retried on the next ask). */
export function loadCrowdConfig(): Promise<CrowdConfig | null> {
	asked ??= fetch("/api/crowd", { headers: { accept: "application/json" } })
		.then((r) => (r.ok || r.status === 404 ? (r.json() as Promise<CrowdConfig>) : null))
		.then((c) => {
			// 404 is the switched-off instance: the body says so ({enabled: false} or an error), never a report button.
			const config =
				c && Array.isArray(c.services) ? c : c ? ({ ...c, enabled: false } as CrowdConfig) : null;
			if (config) crowdConfig.value = config;
			return config;
		})
		.catch(() => {
			asked = null;
			return null;
		});
	return asked;
}

/** Opens the report sheet, starting from a municipality (`ve.zulia.maracaibo`) when the reader is looking at one. */
export function openReport(municipality: string | null = null): void {
	reportSheet.value = { municipality };
}

/** Whether to offer the report: only once this Vigía said it takes them. */
export function crowdOn(): boolean {
	return crowdConfig.value?.enabled === true;
}

/** A municipality's entity id (three segments under `ve`), the only level a report is about. */
export function isMunicipalityId(id: string | null | undefined): id is string {
	return typeof id === "string" && /^ve\.[a-z0-9-]+\.[a-z0-9-]+$/.test(id);
}
