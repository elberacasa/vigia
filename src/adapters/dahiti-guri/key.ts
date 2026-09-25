import type { KeySpec } from "../../sources/keyspec.ts";
import { DAHITI_KEY_ID, GURI_DAHITI_ID } from "./index.ts";

/**
 * DAHITI API key: unlocks the Guri reservoir level. Free account at DGFI-TUM, no card (register page checked
 * 2026-09-24: username, name, e-mail, organisation, country, a line of motivation, and acceptance of the CC BY 4.0
 * licence and the non-commercial terms). Vigía makes one request a day.
 */
export const dahitiKey: KeySpec = {
	id: DAHITI_KEY_ID,
	provider: "DAHITI (DGFI-TUM)",
	name: { es: "Clave API de DAHITI", en: "DAHITI API key" },
	cost: "free-no-card",
	unlocks: {
		es: "El nivel del embalse de Guri medido desde satélites (altimetría), del que depende la mayor parte de la electricidad del país.",
		en: "The Guri reservoir's level measured from satellites (altimetry), which most of the country's electricity depends on.",
	},
	signupUrl: "https://dahiti.dgfi.tum.de/en/register/",
	minutes: 5,
	steps: {
		es: [
			"Abre la página de registro de DAHITI y crea una cuenta gratuita (uso no comercial; no piden tarjeta).",
			"Confirma el correo y entra con tu usuario.",
			"Copia tu clave API (DAHITI la muestra en tu cuenta; su página de preguntas frecuentes explica dónde).",
			"Pégala aquí. Vigía la usa solo para pedir, una vez al día, la serie de Guri (DAHITI-ID 67).",
		],
		en: [
			"Open DAHITI's register page and create a free account (non-commercial use; no card asked).",
			"Confirm your email and sign in.",
			"Copy your API key (DAHITI shows it in your account; its FAQ explains where).",
			"Paste it here. Vigía uses it only to request Guri's series (DAHITI-ID 67) once a day.",
		],
	},
	async validate(key, http) {
		const k = key.trim();
		if (!/^[\w-]{8,128}$/.test(k)) return "La clave de DAHITI tiene un formato inesperado.";
		// Harmless: target info for Guri, a few hundred bytes.
		const res = await http.request("https://dahiti.dgfi.tum.de/api/v2/get-target-info/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ api_key: k, dahiti_id: GURI_DAHITI_ID }),
			okStatuses: [400, 401, 403],
			retries: 1,
			timeoutMs: 20_000,
		});
		if (res.status === 403) return "DAHITI rechazó la clave (Permission Denied).";
		if (res.status !== 200) return `DAHITI respondió ${res.status} al comprobar la clave.`;
		try {
			const body = JSON.parse(res.body) as { code?: unknown };
			if (body.code === 200) return null;
		} catch {
			// fall through
		}
		return "Respuesta inesperada de DAHITI al comprobar la clave.";
	},
};
