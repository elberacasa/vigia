import type { KeySpec } from "../../sources/keyspec.ts";
import { CLOUDFLARE_KEY_ID } from "./index.ts";

/**
 * Cloudflare API token with Radar read access: unlocks the Cloudflare Radar feed. A free Cloudflare account (email and
 * password; no domain needed), then a custom API token with the permission Account › Radar › Read
 * (developers.cloudflare.com/radar/get-started/first-request/). The Radar docs say the API is free to everyone; "no
 * card" is not verified here by signing up. Vigía makes 3 requests every 30 min; the API allows 1,200 per 5 minutes.
 */
export const cloudflareRadarKey: KeySpec = {
	id: CLOUDFLARE_KEY_ID,
	provider: "Cloudflare Radar",
	name: { es: "Token de la API de Cloudflare (Radar)", en: "Cloudflare API token (Radar)" },
	cost: "free-no-card",
	unlocks: {
		es: "Cloudflare Radar para Venezuela: los cortes de internet que publican sus analistas (con causa y alcance), sus anomalías de tráfico detectadas y la curva de tráfico del país. Una tercera vista independiente junto a IODA y RIPE Atlas.",
		en: "Cloudflare Radar for Venezuela: the internet outages its analysts publish (with cause and scope), its detected traffic anomalies and the country's traffic curve. A third independent view next to IODA and RIPE Atlas.",
	},
	signupUrl: "https://dash.cloudflare.com/sign-up",
	minutes: 5,
	steps: {
		es: [
			"Crea una cuenta gratuita de Cloudflare (correo y contraseña; no hace falta tarjeta ni dominio).",
			"En el panel, abre Mi perfil › Tokens de API › Crear token › Token personalizado.",
			"Dale el permiso Cuenta › Radar › Leer y crea el token.",
			"Copia el token (se muestra una sola vez) y pégalo aquí. Vigía lo usa solo para leer Radar sobre Venezuela.",
		],
		en: [
			"Create a free Cloudflare account (email and password; no card or domain needed).",
			"In the dashboard, open My Profile › API Tokens › Create Token › Custom token.",
			"Give it the permission Account › Radar › Read and create the token.",
			"Copy the token (it is shown once) and paste it here. Vigía uses it only to read Radar about Venezuela.",
		],
	},
	async validate(key, http) {
		const k = key.trim();
		if (!/^[\w-]{30,100}$/.test(k)) return "El token de Cloudflare tiene un formato inesperado.";
		// Harmless: one outage annotation of the last day.
		const res = await http.request(
			"https://api.cloudflare.com/client/v4/radar/annotations/outages?limit=1&dateRange=1d&format=json",
			{
				headers: { authorization: `Bearer ${k}` },
				okStatuses: [400, 401, 403],
				retries: 1,
				timeoutMs: 20_000,
			},
		);
		if (res.status === 401 || res.status === 403 || res.status === 400)
			return "Cloudflare rechazó el token (¿tiene el permiso Radar › Leer?).";
		try {
			const body = JSON.parse(res.body) as { success?: unknown };
			if (body.success === true) return null;
		} catch {
			// fall through
		}
		return "Respuesta inesperada de Cloudflare al comprobar el token.";
	},
};
