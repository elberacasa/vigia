import { expect, test } from "bun:test";
import { parseIssue } from "./index.ts";
import { classifyAct, stripIds } from "./redact.ts";

// Code review 4 (H1): 29 realistic sumario wordings that name a person or carry an identity number. Since
// 2026-09-25 acts about public officials (appointments, transfers, delegations, promotions, removals, decorations)
// are listed with their names; pensions, other personal matters of private persons and every ID number stay out.
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

/** The cases about private persons: pensions, a company, a lawyer's licence, a foreigner's passport. */
const PRIVATE_CASES = new Set([4, 9, 10, 15, 20, 23]);

/** Identity numbers in the cases above; none may survive anywhere in what is kept. */
const ID_NUMBERS =
	/12\.?345\.?678|84\.?123|9\.?876|5\.?555|123\.?456|123456789|12345678-9|C\.I\.|c[ée]dula|RIF|Pasaporte|Inpreabogado/u;

/** Names that appear only in the private cases; none may survive anywhere in what is kept. */
const PRIVATE_NAMES = /Ñúñez|Rosa Elena|Luisa|Mora\b|Ivanova|Olga|JOSÉ GARCÍA|INVERSIONES|E-84/u;

test("the 29 wordings: private persons withheld as a category; officials listed with names, never with IDs", () => {
	expect(REVIEW_CASES).toHaveLength(29);
	REVIEW_CASES.forEach((c, i) => {
		const r = classifyAct(c);
		if (PRIVATE_CASES.has(i)) {
			expect({ c, listed: r.listed, title: r.title }).toEqual({ c, listed: false, title: null });
			expect(r.category).not.toBeNull();
		} else {
			expect({ c, listed: r.listed, category: r.category }).toEqual({ c, listed: true, category: null });
			expect({ c, title: r.title }).toEqual({ c, title: expect.not.stringMatching(ID_NUMBERS) });
		}
	});
});

test("appointments show verbatim with the official's name, and without the identity number", () => {
	const title = (i: number) => classifyAct(REVIEW_CASES[i] as string).title;
	expect(title(0)).toBe(
		"Decreto N° 5.001, mediante el cual se designa al ciudadano JOSÉ LUIS PÉREZ RODRÍGUEZ, como Viceministro",
	);
	expect(title(1)).toBe("Resolución mediante la cual se designa al ciudadano José Luis Pérez, como Director");
	expect(title(5)).toBe("Resolución mediante la cual se designa a la ciudadana ana maría pérez");
	expect(title(7)).toBe("Se designa como Viceministro de Planificación a JUAN CARLOS PEÑA");
	expect(title(12)).toBe("Resolución mediante la cual se designa al ciudadano JUAN PÉREZ como Cónsul");
	expect(title(16)).toBe(
		"Decreto mediante el cual se nombra a Luis Alberto Mendoza Presidente de la Corporación",
	);
	expect(title(21)).toBe("Resolución mediante la cual se delega en el Viceministro Manuel Ruiz la firma");
	// Encargadurías, a bare unlabelled number, and a decoration.
	expect(
		classifyAct(
			"Resolución mediante la cual se encarga a la ciudadana ANA RUIZ, titular de la cédula de identidad N° V-12.345.678, de la Dirección General",
		),
	).toEqual({
		listed: true,
		title: "Resolución mediante la cual se encarga a la ciudadana ANA RUIZ, de la Dirección General",
		category: null,
		named: true,
	});
	expect(
		classifyAct("Resolución mediante la cual se designa al ciudadano LUIS GIL (12345678) como Director")
			.title,
	).toBe("Resolución mediante la cual se designa al ciudadano LUIS GIL como Director");
	// A transfer to a public post is an appointment to it.
	expect(
		classifyAct(
			"Resolución mediante la cual se traslada a la ciudadana Laura Gil, como Fiscal Auxiliar Interino a la Fiscalía Segunda",
		).title,
	).toBe(
		"Resolución mediante la cual se traslada a la ciudadana Laura Gil, como Fiscal Auxiliar Interino a la Fiscalía Segunda",
	);
	const medal =
		"Resolución mediante la cual se otorga la Condecoración “Orden a la Paz”, a las ciudadanas y ciudadanos que en ella se mencionan";
	expect(classifyAct(medal)).toEqual({ listed: true, title: medal, category: null, named: true });
});

test("promotions, removals and officials named in office are listed with names, without ID numbers", () => {
	for (const [raw, title] of [
		[
			"Resolución mediante la cual se asciende al General de Brigada JUAN PÉREZ al grado de General de División",
			"Resolución mediante la cual se asciende al General de Brigada JUAN PÉREZ al grado de General de División",
		],
		[
			"Resolución mediante la cual se asciende a los oficiales de la Fuerza Armada Nacional Bolivariana que en ella se mencionan",
			"Resolución mediante la cual se asciende a los oficiales de la Fuerza Armada Nacional Bolivariana que en ella se mencionan",
		],
		[
			"Resolución mediante la cual se remueve al ciudadano JUAN PÉREZ, C.I. V-12.345.678, del cargo de Director",
			"Resolución mediante la cual se remueve al ciudadano JUAN PÉREZ, del cargo de Director",
		],
		[
			"Resolución mediante la cual se impone la sanción de destitución al funcionario JUAN PÉREZ",
			"Resolución mediante la cual se impone la sanción de destitución al funcionario JUAN PÉREZ",
		],
		[
			"Resolución mediante la cual se suspende al funcionario Luis Gil del cargo de Fiscal",
			"Resolución mediante la cual se suspende al funcionario Luis Gil del cargo de Fiscal",
		],
		[
			"Resolución mediante la cual se reincorpora a la ciudadana Ana Ruiz al cargo de Jueza",
			"Resolución mediante la cual se reincorpora a la ciudadana Ana Ruiz al cargo de Jueza",
		],
		// General-form acts naming officials acting in office.
		[
			"Nota Diplomática mediante la cual la ciudadana Ana Ruiz, Presidenta (E) de la República, recibió en audiencia solemne las cartas credenciales del Embajador",
			"Nota Diplomática mediante la cual la ciudadana Ana Ruiz, Presidenta (E) de la República, recibió en audiencia solemne las cartas credenciales del Embajador",
		],
		[
			"Providencia mediante la cual se autoriza de forma mancomunada a los ciudadanos Ana Ruiz, en su carácter de Presidenta (E), y Luis Gil, en su carácter de Director (E) de Gestión Administrativa",
			"Providencia mediante la cual se autoriza de forma mancomunada a los ciudadanos Ana Ruiz, en su carácter de Presidenta (E), y Luis Gil, en su carácter de Director (E) de Gestión Administrativa",
		],
		[
			"Decreto mediante el cual se crea la Comisión presidida por el Ministro Juan Ejemplo.",
			"Decreto mediante el cual se crea la Comisión presidida por el Ministro Juan Ejemplo.",
		],
		[
			"Resolución mediante la cual se modifica la Comisión; estará integrada por los funcionarios que en ella se indican.",
			"Resolución mediante la cual se modifica la Comisión; estará integrada por los funcionarios que en ella se indican.",
		],
	] as const)
		expect({ raw, r: classifyAct(raw) }).toEqual({
			raw,
			r: { listed: true, title, category: null, named: true },
		});
});

test("still withheld: pensions and personal benefits (even of an official), private parties' matters", () => {
	// A transfer that is a personal matter (a pension on transfer) stays out.
	expect(
		classifyAct("Resolución mediante la cual se traslada y se otorga la pensión a la ciudadana X").listed,
	).toBe(false);
	const cat = (s: string) => classifyAct(s);
	for (const [s, category] of [
		[
			"Resolución mediante la cual se otorga pensión de sobreviviente a la ciudadana ana maría pérez, cédula N° 12.345.678",
			"jubilacion",
		],
		["Providencia mediante la cual se otorga la jubilación a la ciudadana Rosa Elena Ñúñez", "jubilacion"],
		[
			"Resolución mediante la cual se designa a la ciudadana ANA PÉREZ como Directora y se le otorga el beneficio de jubilación",
			"jubilacion",
		],
		[
			"Resolución mediante la cual se designa a la ciudadana ANA PÉREZ como beneficiaria de la beca",
			"personal",
		],
		["Decreto mediante el cual se otorga la nacionalidad venezolana y se designa a JUAN PÉREZ", "personal"],
		[
			"Resolución mediante la cual se otorga a la ciudadana Ana Ruiz, en su carácter de Directora, el beneficio de jubilación",
			"jubilacion",
		],
		["Resolución mediante la cual se pasa a situación de retiro al Coronel JUAN PÉREZ", "jubilacion"],
		[
			"Resolución mediante la cual se autoriza a la empresa Ejemplo C.A., en su carácter de contratista del Ministerio, a importar",
			"personal",
		],
		[
			"Providencia mediante la cual se otorga licencia al ciudadano extranjero Olaf Ejemplo, en su carácter de Director de la sucursal",
			"personal",
		],
		["Resolución mediante la cual se crea la Comisión a cargo de Ana Ejemplo.", "personal"],
	] as const)
		expect({ s, r: cat(s) }).toEqual({ s, r: { listed: false, title: null, category } });
});

test("the 29 wordings in an issue page: appointments listed, no private name and no identity number anywhere", () => {
	const rows = REVIEW_CASES.map(
		(t) =>
			`<tr><td>MINISTERIO DEL PODER POPULAR PARA LA DEFENSA</td><td></td><td>${t}</td><td>1</td><td>1</td></tr>`,
	).join("");
	const html = `<html><body><h5>Detalles de la Gaceta Nro 50.001</h5><table class="table"><thead><tr><th>Número de Gaceta</th></tr></thead><tbody><tr><td>50.001</td><td>ORDINARIA</td><td>GACETA OFICIAL</td><td>11/09/2026</td><td>1</td><td>8</td><td>PUBLICADO</td></tr></tbody></table>
<table id="sumarios-table"><thead><tr><th>Órgano</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
	const issue = parseIssue(html);
	expect(issue.acts).toHaveLength(29);
	expect(issue.acts.filter((a) => a.title === null && a.withheld !== null)).toHaveLength(PRIVATE_CASES.size);
	expect(issue.acts.filter((a) => a.title !== null && a.withheld === null)).toHaveLength(
		29 - PRIVATE_CASES.size,
	);
	const text = JSON.stringify(issue);
	expect(text).not.toMatch(ID_NUMBERS);
	expect(text).not.toMatch(PRIVATE_NAMES);
	expect(text).toContain("JOSÉ LUIS PÉREZ RODRÍGUEZ");
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
		expect(classifyAct(s)).toEqual({ listed: true, title: s, category: null, named: false });
});

test("default deny: an unknown form, a name after an honorific, capitals, quotes, or an ID is withheld", () => {
	for (const s of [
		"Nota mediante la cual se hace constar algo.",
		"Decreto mediante el cual se crea la Fundación dirigida por el Dr. Juan Ejemplo.",
		"Decreto mediante el cual se crea la Fundación INVERSIONES EJEMPLO.",
		"Resolución mediante la cual se crea la Oficina “JUAN EJEMPLO”.",
		"Resolución mediante la cual se corrige la Resolución N° 12.345.678.",
		"Resolución mediante la cual se crea la Comisión a cargo de Ana Ejemplo.",
		"Acuerdo de duelo por el fallecimiento del Diputado Ejemplo.",
	])
		expect({ s, r: classifyAct(s).listed }).toEqual({ s, r: false });
});
