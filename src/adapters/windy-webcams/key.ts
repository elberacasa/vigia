import type { KeySpec } from "../../sources/keyspec.ts";
import { WINDY_KEY_ID } from "./index.ts";

/**
 * Windy Webcams API key: unlocks the list of cameras their owners registered on Windy in Venezuela, near Cúcuta and on
 * the ABC islands (state and player link only; images are never stored, by Windy's terms). Free plan per Windy's
 * pricing page ("Free … Get API key", read 2026-09-29); a Windy account is needed. The key must not be published
 * (Windy's terms), so it lives only in the user's own key store or .env.
 */
export const windyKey: KeySpec = {
	id: WINDY_KEY_ID,
	provider: "Windy.com",
	name: { es: "Clave de Windy Webcams", en: "Windy Webcams key" },
	cost: "free-no-card",
	unlocks: {
		es: "La lista de cámaras públicas registradas en Windy en Venezuela, la zona de Cúcuta y las islas ABC, con su estado y el reproductor de Windy (sin guardar imágenes).",
		en: "The list of public cameras registered on Windy in Venezuela, the Cúcuta area and the ABC islands, with their state and Windy's player (no images stored).",
	},
	signupUrl: "https://api.windy.com/keys",
	minutes: 5,
	steps: {
		es: [
			"Abre api.windy.com/keys y entra o crea una cuenta de Windy (el plan gratuito de la API de cámaras no pide pago según su página de precios, revisada el 2026-09-29).",
			"Crea una clave para «Webcams API».",
			"Pégala aquí. Vigía la envía solo a api.windy.com, en una cabecera, tres veces por hora como máximo. No la publiques: los términos de Windy lo prohíben.",
		],
		en: [
			"Open api.windy.com/keys and sign in or create a Windy account (the webcams API's free plan asks for no payment according to its pricing page, read 2026-09-29).",
			"Create a key for “Webcams API”.",
			"Paste it here. Vigía sends it only to api.windy.com, in a header, at most three times an hour. Do not publish it: Windy's terms forbid that.",
		],
	},
	async validate(key, http) {
		const k = key.trim();
		if (!/^[\w-]{8,128}$/.test(k)) return "La clave de Windy tiene un formato inesperado.";
		const res = await http.request("https://api.windy.com/webcams/api/v3/webcams?countries=VE&limit=1", {
			headers: { accept: "application/json", "x-windy-api-key": k },
			okStatuses: [401, 403],
			retries: 1,
			timeoutMs: 20_000,
		});
		if (res.status === 401 || res.status === 403) return "Windy rechazó la clave.";
		try {
			const body = JSON.parse(res.body) as { webcams?: unknown };
			if (Array.isArray(body.webcams)) return null;
		} catch {
			// fall through
		}
		return "Respuesta inesperada de Windy al comprobar la clave.";
	},
};
