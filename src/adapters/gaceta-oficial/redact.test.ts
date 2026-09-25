import { expect, test } from "bun:test";
import { parseIssue } from "./index.ts";
import { classifyAct, stripIds } from "./redact.ts";

// Code review 4 (H1): 29 realistic sumario wordings that name a person or carry an identity number. The old
// redaction listed most of them word for word. Every one must be withheld (no text kept, only a category).
const REVIEW_CASES = [
	"Decreto N° 5.001, mediante el cual se designa al ciudadano JOSÉ LUIS PÉREZ RODRÍGUEZ, titular de la cédula de identidad N° V-12.345.678, como Viceministro",
	"Resolución mediante la cual se designa al ciudadano José Luis Pérez, C.I. V-12345678, como Director",
	"Resolución mediante la cual se designa a JOSÉ LUIS PÉREZ RODRÍGUEZ, C.I. V-12.345.678, como Director General",
	"Resolución por la cual se designa a la ciudadana MARÍA DE LOS ÁNGELES GÓMEZ DE LA TORRE como Directora",
	"Resolución mediante la cual se otorga pensión a la ciudadana E-84.123.456 ANA PÉREZ",
	"Resolución mediante la cual se designa a la ciudadana ana maría pérez, cédula N° 12.345.678",
	"Se designa como Viceministro de Planificación al ciudadano JUAN D'AMBROSIO PÉREZ-GARCÍA",
	"Se designa como Viceministro de Planificación a JUAN CARLOS PEÑA",
	"Resolución mediante la cual se asciende al General de Brigada JUAN PÉREZ al grado de General de División",
	"Providencia mediante la cual se otorga la jubilación a la ciudadana Rosa Elena Ñúñez, portadora de la cédula de identidad V- 9.876.543",
	"Providencia que autoriza a la empresa INVERSIONES PÉREZ C.A., RIF J-12345678-9, a operar",
	'Resolución mediante la cual se designa al ciudadano "JUAN PÉREZ" como Cónsul',
	"Resolución mediante la cual se designa al ciudadano\nJUAN\nPÉREZ como Cónsul",
	"Resolución mediante la cual se designa a los ciudadanos JUAN PÉREZ y MARÍA GÓMEZ como miembros de la Junta Directiva",
	"Resolución mediante la cual se designa a la Ciudadana CARMEN RUIZ Directora",
	"Resolución mediante la cual se otorga pensión de sobreviviente a la ciudadana Luisa Mora (C.I. N° 5.555.555)",
	"Decreto mediante el cual se nombra a Luis Alberto Mendoza Presidente de la Corporación",
	"Resolución mediante la cual se designa al Ciudadano Coronel PEDRO ÁLVAREZ, como Director",
	"Resolución mediante la cual se designa al ciudadano PEDRO ÁLVAREZ y se le delegan atribuciones",
	"Resolución mediante la cual se designa a la ciudadana ANA PÉREZ, Directora; y al ciudadano LUIS GIL, Subdirector",
	"Acto mediante el cual se autoriza al Abogado JOSÉ GARCÍA, Inpreabogado N° 123.456",
	"Resolución mediante la cual se delega en el Viceministro Manuel Ruiz la firma",
	"Resolución mediante la cual se designa al ciudadano Ing. RAMÓN SOTO, como Gerente",
	"Pasaporte N° 123456789 de la ciudadana extranjera Olga Ivanova",
	"Resolución mediante la cual se designa al Dr. HÉCTOR LÓPEZ",
	"Resolución mediante la cual se designa a la ciudadana Dra. ELENA RÍOS como Directora",
	"Resolución mediante la cual se designa al ciudadano JOSÉ PÉREZ en calidad de Director",
	"Resolución mediante la cual se designa al ciudadano JOSÉ PÉREZ, Director de la Oficina",
	"Resolución mediante la cual se designa al ciudadano JOSÉ PÉREZ Director de la Oficina de Gestión",
];

/** Name fragments and numbers in the cases above; none may survive anywhere in what is kept. */
const SECRETS =
	/P[ÉE]REZ|Pérez|pérez|RODR[ÍI]GUEZ|G[ÓO]MEZ|PEÑA|[ÁA]LVAREZ|Ñúñez|Rosa Elena|Mora|Mendoza|RUIZ|Ruiz|GARC[ÍI]A|SOTO|L[ÓO]PEZ|R[ÍI]OS|Ivanova|CARMEN|GIL\b|D'AMBROSIO|12\.?345\.?678|84\.?123|9\.?876|5\.?555|123\.?456|123456789/u;

test("review 4 H1: all 29 wordings are withheld, as a category, with no text", () => {
	expect(REVIEW_CASES).toHaveLength(29);
	for (const c of REVIEW_CASES) {
		const r = classifyAct(c);
		expect({ c, listed: r.listed, title: r.title }).toEqual({ c, listed: false, title: null });
		expect(r.category).not.toBeNull();
	}
});

test("review 4 H1: the categories say what kind of act it was", () => {
	const cat = (s: string) => classifyAct(s).category;
	expect(cat(REVIEW_CASES[0] as string)).toBe("designacion");
	expect(
		cat(
			"Resolución mediante la cual se otorga pensión de sobreviviente a la ciudadana ana maría pérez, cédula N° 12.345.678",
		),
	).toBe("jubilacion");
	expect(cat("Providencia mediante la cual se otorga la jubilación a la ciudadana Rosa Elena Ñúñez")).toBe(
		"jubilacion",
	);
	expect(cat("Resolución mediante la cual se asciende al General de Brigada JUAN PÉREZ")).toBe("ascenso");
	expect(cat("Resolución mediante la cual se traslada a la ciudadana X, como Fiscal")).toBe("traslado");
	expect(cat("Resolución mediante la cual se delega en el Viceministro Manuel Ruiz la firma")).toBe(
		"delegacion",
	);
	expect(
		cat(
			"Resolución mediante la cual se otorga la Condecoración “Orden a la Paz”, a las ciudadanas y ciudadanos que en ella se mencionan",
		),
	).toBe("condecoracion");
});

test("review 4 H1: the 29 wordings in an issue page leave no name or number in the parsed issue", () => {
	const rows = REVIEW_CASES.map(
		(t) =>
			`<tr><td>MINISTERIO DEL PODER POPULAR PARA LA DEFENSA</td><td></td><td>${t}</td><td>1</td><td>1</td></tr>`,
	).join("");
	const html = `<html><body><h5>Detalles de la Gaceta Nro 50.001</h5><table class="table"><thead><tr><th>Número de Gaceta</th></tr></thead><tbody><tr><td>50.001</td><td>ORDINARIA</td><td>GACETA OFICIAL</td><td>11/09/2026</td><td>1</td><td>8</td><td>PUBLICADO</td></tr></tbody></table>
<table id="sumarios-table"><thead><tr><th>Órgano</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
	const issue = parseIssue(html);
	expect(issue.acts).toHaveLength(29);
	expect(issue.acts.every((a) => a.title === null && a.withheld !== null)).toBe(true);
	expect(JSON.stringify(issue)).not.toMatch(SECRETS);
});

test("identity numbers: every spelling is stripped", () => {
	for (const s of [
		"titular de la cédula de identidad N° V-12.345.678",
		"cédula N° 12.345.678",
		"C.I. V-12345678",
		"C.I. N° 5.555.555",
		"CI: 12345678",
		"V-12.345.678",
		"E-84.123.456",
		"V- 9.876.543",
		"V12345678",
		"RIF J-12345678-9",
		"R.I.F. G-20000001-5",
		"J-12345678-9",
		"Pasaporte N° 123456789",
		"Inpreabogado N° 123.456",
		"N° 12.345.678",
		"N° 1234567",
		"12.345.678",
	]) {
		const r = stripIds(`al ciudadano X, ${s}, como Director`);
		expect({ s, found: r.found }).toEqual({ s, found: true });
		expect({ s, text: r.text }).toEqual({ s, text: expect.not.stringMatching(/\d{3}/) });
	}
	// Gaceta, decree and resolution numbers are not identity numbers.
	for (const s of ["Gaceta Oficial N° 43.407", "Decreto N° 5.432", "Resolución Nº 008", "artículo 1"])
		expect(stripIds(s)).toEqual({ text: s, found: false });
});

test("the allowlist: act forms that name no one are listed word for word", () => {
	for (const s of [
		"Ley Orgánica de Reforma Parcial de la Ley Orgánica del Tribunal Supremo de Justicia.",
		"Ley Aprobatoria del Acuerdo Marco para el Establecimiento de la Alianza Internacional de Grandes Felinos.",
		"Decreto N° 5.432, mediante el cual se autoriza la distribución de un crédito adicional, con cargo al presupuesto de egresos vigente.",
		"Decreto N° 5.430, mediante el cual se modifica la denominación del Despacho del Viceministro o de la Viceministra de Servicios para la Defensa.",
		"Resolución mediante la cual se dictan las Normas que Regirán la Constitución del Encaje.",
		"Resolución mediante la cual se crea el Consulado General de la República Bolivariana de Venezuela en la República de Chile.",
		"Aviso Oficial mediante el cual se informa a las instituciones bancarias los límites máximos de las comisiones.",
		"Acuerdo en respaldo al Convenio Energético Binacional entre la República Bolivariana de Venezuela y los Estados Unidos de América.",
	])
		expect(classifyAct(s)).toEqual({ listed: true, title: s, category: null });
});

test("default deny: an unknown form, a name after an office or rank, capitals, quotes, or an ID is withheld", () => {
	for (const s of [
		"Nota mediante la cual se hace constar algo.",
		"Decreto mediante el cual se crea la Comisión presidida por el Ministro Juan Ejemplo.",
		"Decreto mediante el cual se crea la Fundación INVERSIONES EJEMPLO.",
		"Resolución mediante la cual se crea la Oficina “JUAN EJEMPLO”.",
		"Resolución mediante la cual se corrige la Resolución N° 12.345.678.",
		"Resolución mediante la cual se modifica la Comisión; estará integrada por los funcionarios que en ella se indican.",
		"Resolución mediante la cual se crea la Comisión a cargo de Ana Ejemplo.",
		"Acuerdo de duelo por el fallecimiento del Diputado Ejemplo.",
	])
		expect({ s, r: classifyAct(s).listed }).toEqual({ s, r: false });
});
