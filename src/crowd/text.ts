/**
 * One wording for a published crowd aggregate, used by the panel, the entity pages, the timeline and the incident
 * evidence, so "12 reportes" never reads differently in two places. Always "reportes de usuarios", never a
 * measurement.
 */

import { CROWD_RULES, SERVICE_TEXT, type Service } from "./rules.ts";
import type { CrowdAggregate } from "./service.ts";

const HOUR = 3_600_000;

const n = (x: number, l: "es" | "en") => x.toLocaleString(l === "es" ? "es-VE" : "en-US");

export function crowdLabel(service: Service): { es: string; en: string } {
	return {
		es: `Reportes de usuarios: ${SERVICE_TEXT[service].es}`,
		en: `User reports: ${SERVICE_TEXT[service].en}`,
	};
}

/** "17 reportes en 2 h: 12 «no», 3 «intermitente», 2 «sí»", plus the held count when flagged. */
export function crowdText(
	a: Pick<
		CrowdAggregate,
		"level" | "reports" | "answers" | "held" | "flagged" | "windowMs" | "municipalities"
	> &
		Partial<Pick<CrowdAggregate, "connections">>,
): {
	es: string;
	en: string;
} {
	const h = Math.round((a.windowMs || CROWD_RULES.windowMs) / HOUR);
	const heldEs = a.flagged ? `${n(a.held, "es")} retenidos por posible manipulación, no se cuentan` : "";
	const heldEn = a.flagged ? `${n(a.held, "en")} held as possible manipulation, not counted` : "";
	// Rows older than the "never below the minimum" rule could be a flag alone.
	if (a.reports === null || a.answers === null)
		return {
			es: `Posible manipulación: ${heldEs || "reportes retenidos"}; reportes insuficientes para mostrar el resto.`,
			en: `Possible manipulation: ${heldEn || "reports held"}; too few reports to show the rest.`,
		};
	const where =
		a.level === "state"
			? {
					es: ` en ${a.municipalities} ${a.municipalities === 1 ? "municipio" : "municipios"}`,
					en: ` in ${a.municipalities} ${a.municipalities === 1 ? "municipality" : "municipalities"}`,
				}
			: { es: "", en: "" };
	// Phones behind one address (device tokens) are reports, not more connections: say so when they differ.
	const conns = a.connections ?? a.reports;
	const via =
		conns < a.reports
			? {
					es: ` de ${n(conns, "es")} ${conns === 1 ? "conexión" : "conexiones"}`,
					en: ` from ${n(conns, "en")} ${conns === 1 ? "connection" : "connections"}`,
				}
			: { es: "", en: "" };
	const es = `${n(a.reports, "es")} ${a.reports === 1 ? "reporte" : "reportes"}${via.es} en ${h} h${where.es}: ${n(a.answers.no, "es")} «no», ${n(a.answers.intermitente, "es")} «intermitente», ${n(a.answers.si, "es")} «sí»`;
	const en = `${n(a.reports, "en")} ${a.reports === 1 ? "report" : "reports"}${via.en} in ${h} h${where.en}: ${n(a.answers.no, "en")} "no", ${n(a.answers.intermitente, "en")} "on and off", ${n(a.answers.si, "en")} "yes"`;
	return { es: heldEs ? `${es} (${heldEs})` : es, en: heldEn ? `${en} (${heldEn})` : en };
}

/** How the figure is made, for "calculado por Vigía". */
export function crowdMethod(level: CrowdAggregate["level"], minReporters: number): string {
	return level === "state"
		? `Suma de los reportes de sus municipios que se muestran (cada uno con al menos ${minReporters} conexiones distintas; una conexión puede reportar en más de uno), contada por Vigía. No es una medición.`
		: `Reportes anónimos de usuarios de esta instancia, uno por conexión, o por teléfono detrás de una misma dirección si la página envía su identificador aleatorio (hasta ${CROWD_RULES.perClient.devicesPerPair} por dirección), y por servicio (una respuesta nueva reemplaza la anterior), contados por Vigía en bloques de ${Math.round(CROWD_RULES.bucketMs / 60_000)} min; se muestran con al menos ${minReporters} reportes (de ${CROWD_RULES.minConnections.public} conexiones distintas en un espejo público). No es una medición.`;
}
