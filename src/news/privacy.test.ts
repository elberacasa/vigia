import { expect, test } from "bun:test";
import { isCourtNotice, redactNewsText } from "./privacy.ts";

// Titles as the outlets published them (el-impulso, nuevo-dia, diario-el-vistazo, notiapure, el-tubazo,
// el-guayanes), found stored and linked to places by the review of 29 Sept 2026. Names are altered; the forms are not.
test("court notices, in every form the outlets print them, are recognised", () => {
	for (const t of [
		"Edicto.Nombre Apellido Apellido.",
		"Edicto – Solicitud de Declaración de Únicos y Universales Herederos del de cujus",
		"Cartel de Emplazamiento.Nombre Apellido.",
		"Cartel de Citación a los ciudadanos Nombre Apellido y Nombre Apellido",
		"Cartel de Intimación del Juzgado Segundo de Primera Instancia en lo Civil, Mercantil",
		"Edicto del Tribunal Octavo de los municipios Simón Bolívar, Urbaneja, Sotillo y Guanta",
		"EDICTO. ACCIÓN MERO DECLARATIVA DE UNIÓN CONCUBINARIA, instaurada por el ciudadano",
		"EDICTO/ Tribunal admitió demanda con motivo de prescripción adquisitiva",
		"CARTEL DE EMPLAZAMIENTO",
		"Avisos judiciales: Cartel de notificación",
	])
		expect({ t, notice: isCourtNotice(t) }).toEqual({ t, notice: true });
	expect(isCourtNotice("Aviso", "El tribunal cita y emplaza a los herederos desconocidos")).toBe(true);
});

test("news about courts, identity cards and places is kept", () => {
	for (const t of [
		"Saime habilita trámite en línea para corregir datos en la cédula: siga estos pasos",
		"Inician reparaciones del Cuartel de la Montaña en el 23 de Enero",
		"Tribunal notifica a la defensa de los detenidos la fecha de la audiencia",
		"El matrimonio de una actriz llega a su fin ante un tribunal de Nueva York",
		"Jornada de Alcaldía de Barinas renovó cédulas a 550 empleados y familiares",
	])
		expect({ t, notice: isCourtNotice(t) }).toEqual({ t, notice: false });
	// Known and accepted: a headline that opens with "Edictos" is taken as a notice. Missing a real notice would
	// publish a private person's name and identity number; dropping a rare history headline costs little.
	expect(isCourtNotice("Edictos del gobierno: la historia de las leyes coloniales")).toBe(true);
});

test("identity numbers are stripped from kept text; money and population figures are not", () => {
	expect(redactNewsText("Detenido Nombre Apellido, cédula de identidad V-24.143.763, en Maturín")).toBe(
		"Detenido Nombre Apellido, en Maturín",
	);
	expect(redactNewsText("Liquidez de Bs 2.839.145 millones; 1.413.115 habitantes en Bolívar")).toBe(
		"Liquidez de Bs 2.839.145 millones; 1.413.115 habitantes en Bolívar",
	);
});
