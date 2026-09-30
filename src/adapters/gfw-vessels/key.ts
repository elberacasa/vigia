import type { KeySpec } from "../../sources/keyspec.ts";
import { AREAS, areaPolygon, GFW_TOKEN_ID, reportUrl } from "./index.ts";

/**
 * Global Fishing Watch API token: unlocks the radar (SAR) vessel counts near the oil terminals. A free GFW account
 * and an API access token requested for non-commercial use (globalfishingwatch.org/our-apis/tokens). GFW's
 * documentation describes the token as free for non-commercial use; "no card" is not verified here by signing
 * up. Vigía makes 10 requests a day.
 */
export const gfwVesselsKey: KeySpec = {
	id: GFW_TOKEN_ID,
	provider: "Global Fishing Watch",
	name: { es: "Token de la API de Global Fishing Watch", en: "Global Fishing Watch API token" },
	cost: "free-no-card",
	unlocks: {
		es: "Buques detectados por radar satelital (Sentinel-1) cerca de José, Puerto La Cruz, Paraguaná, El Palito y en el Lago de Maracaibo, y cuántos no transmitían AIS: la señal de los tanqueros «oscuros». Solo conteos.",
		en: "Vessels detected by satellite radar (Sentinel-1) near José, Puerto La Cruz, Paraguaná, El Palito and on Lake Maracaibo, and how many were not broadcasting AIS: the 'dark tanker' signal. Counts only.",
	},
	signupUrl: "https://globalfishingwatch.org/our-apis/tokens",
	minutes: 5,
	steps: {
		es: [
			"Abre la página de tokens de Global Fishing Watch y crea una cuenta gratuita (o entra con la tuya).",
			"Pide un token de acceso a la API: nombre del proyecto (p. ej. «Vigía, uso personal»), uso no comercial.",
			"Copia el token y pégalo aquí. Vigía lo usa solo para pedir, una vez al día, conteos de buques en cinco zonas.",
		],
		en: [
			"Open Global Fishing Watch's token page and create a free account (or sign in).",
			"Request an API access token: project name (e.g. 'Vigía, personal use'), non-commercial use.",
			"Copy the token and paste it here. Vigía uses it only to ask, once a day, for vessel counts in five areas.",
		],
	},
	async validate(key, http) {
		const k = key.trim();
		if (!/^[\w.-]{20,2000}$/.test(k)) return "El token de Global Fishing Watch tiene un formato inesperado.";
		// Harmless: one small area's report (a few hundred bytes).
		const area = AREAS[0];
		if (!area) return "Sin zonas configuradas.";
		const url = reportUrl(Date.now(), area.id, false);
		const res = await http.request(url.slice(0, url.indexOf("#")), {
			method: "POST",
			headers: { authorization: `Bearer ${k}`, "content-type": "application/json" },
			body: JSON.stringify({ geojson: areaPolygon(area) }),
			okStatuses: [401, 403, 422],
			retries: 1,
			timeoutMs: 60_000,
		});
		if (res.status === 401 || res.status === 403) return "Global Fishing Watch rechazó el token.";
		if (res.status !== 200) return `Global Fishing Watch respondió ${res.status} al comprobar el token.`;
		try {
			const body = JSON.parse(res.body) as { entries?: unknown };
			if (Array.isArray(body.entries)) return null;
		} catch {
			// fall through
		}
		return "Respuesta inesperada de Global Fishing Watch al comprobar el token.";
	},
};
