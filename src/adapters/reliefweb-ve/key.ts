import type { KeySpec } from "../../sources/keyspec.ts";
import { RELIEFWEB_KEY_ID, RW_API } from "./index.ts";

/**
 * ReliefWeb API appname: unlocks ReliefWeb's reports and disasters on Venezuela. Since 1 November 2025 the API asks
 * for an appname that ReliefWeb approves: a short Google form linked from apidoc.reliefweb.int/parameters#appname
 * (read 2026-09-29: name, organisation with its website, email, purpose, preferred appname "Org + purpose + random
 * characters"). The form says the API is "primarily for our content partners", that only an organisation's official
 * email address is considered (not Gmail, Yahoo, Hotmail…), and that ReliefWeb answers within two business days.
 * No account, no card. reliefweb.int itself refuses automated readers (HTTP 444, 2026-09-29), so this is the only
 * route Vigía uses. Two requests every 2 hours.
 */
export const reliefwebAppnameKey: KeySpec = {
	id: RELIEFWEB_KEY_ID,
	provider: "ReliefWeb (OCHA)",
	name: { es: "Appname de la API de ReliefWeb", en: "ReliefWeb API appname" },
	cost: "free-no-card",
	unlocks: {
		es: "Los informes humanitarios sobre Venezuela que recoge ReliefWeb (OCHA) y los desastres que sigue en el país, con su número GLIDE.",
		en: "The humanitarian reports on Venezuela that ReliefWeb (OCHA) collects and the disasters it tracks there, with their GLIDE number.",
	},
	signupUrl: "https://apidoc.reliefweb.int/parameters#appname",
	minutes: 5,
	steps: {
		es: [
			"Abre la documentación de la API de ReliefWeb (enlace) y, en «Appname», el formulario corto para pedir uno.",
			"ReliefWeb solo considera solicitudes desde el correo oficial de una organización (no Gmail, Yahoo ni Hotmail) y dice que su API es sobre todo para sus socios de contenido: sin organización, es probable que no lo aprueben.",
			"Propón un appname que combine tu organización, el propósito y caracteres al azar (p. ej. «tuorg-vigia-x7k2») y explica que es un lector de sus informes sobre Venezuela.",
			"ReliefWeb responde por correo en dos días hábiles. Cuando lo aprueben, pega el appname aquí. Vigía hace dos consultas cada 2 horas.",
		],
		en: [
			"Open ReliefWeb's API documentation (link) and, under “Appname”, the short form to request one.",
			"ReliefWeb only considers requests from an organisation's official email address (not Gmail, Yahoo or Hotmail) and says its API is mainly for its content partners: without an organisation it will probably not be approved.",
			"Propose an appname that combines your organisation, the purpose and random characters (e.g. “yourorg-vigia-x7k2”) and explain that it is a reader of its reports on Venezuela.",
			"ReliefWeb answers by email within two business days. Once approved, paste the appname here. Vigía makes two queries every 2 hours.",
		],
	},
	async validate(key, http) {
		const k = key.trim();
		if (!/^[\w.-]{3,100}$/.test(k))
			return "El appname tiene un formato inesperado (letras, números, guiones).";
		// Harmless: a count of reports, no rows.
		const res = await http.request(`${RW_API}/reports?appname=${encodeURIComponent(k)}&limit=0`, {
			headers: { accept: "application/json" },
			okStatuses: [403],
			retries: 1,
			timeoutMs: 20_000,
		});
		if (res.status === 403) return "ReliefWeb todavía no aprobó este appname (o no existe).";
		if (res.status !== 200) return `ReliefWeb respondió ${res.status} al comprobar el appname.`;
		return null;
	},
};
