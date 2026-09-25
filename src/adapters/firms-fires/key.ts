import type { KeySpec } from "../../sources/keyspec.ts";
import { FIRMS_KEY_ID } from "./index.ts";

/**
 * Optional NASA FIRMS MAP_KEY. Without it Vigía downloads the 1.7 MB South America file every hour (~41 MB/day);
 * with it, the area API returns only Venezuela's box (tens of KB). Free, email only (checked 2026-09-24).
 * Limit: 5,000 transactions per 10 minutes; Vigía makes one per hour.
 */
export const firmsMapKey: KeySpec = {
	id: FIRMS_KEY_ID,
	provider: "NASA FIRMS",
	name: { es: "Clave MAP_KEY de NASA FIRMS (opcional)", en: "NASA FIRMS MAP_KEY (optional)" },
	cost: "free-no-card",
	unlocks: {
		es: "Incendios con menos datos descargados: consultas solo sobre Venezuela en lugar del archivo de toda Sudamérica (~41 MB al día sin clave).",
		en: "Fires with less data downloaded: queries for Venezuela only instead of the whole South America file (~41 MB a day without a key).",
	},
	signupUrl: "https://firms.modaps.eosdis.nasa.gov/api/map_key/",
	minutes: 3,
	steps: {
		es: [
			"Abre la página de MAP_KEY de FIRMS y escribe tu correo.",
			"Abre el correo de NASA FIRMS y copia la clave de 32 caracteres.",
			"Pégala aquí. Vigía la usa solo para pedir los focos de calor de Venezuela.",
		],
		en: [
			"Open the FIRMS MAP_KEY page and enter your email address.",
			"Open the email from NASA FIRMS and copy the 32-character key.",
			"Paste it here. Vigía uses it only to request Venezuela's fire detections.",
		],
	},
	async validate(key, http) {
		if (!/^[A-Za-z0-9]{16,64}$/.test(key.trim()))
			return "La clave debe tener solo letras y números (32 caracteres).";
		// Harmless: the key-status endpoint counts no transaction against the area API.
		const res = await http.request(
			`https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=${encodeURIComponent(key.trim())}`,
			{ okStatuses: [400, 401, 403], retries: 1, timeoutMs: 15_000 },
		);
		if (res.status !== 200) return "NASA FIRMS no reconoce la clave (o superó su límite de consultas).";
		try {
			const body = JSON.parse(res.body) as { transaction_limit?: unknown };
			if (typeof body.transaction_limit === "number" || typeof body.transaction_limit === "string")
				return null;
		} catch {
			// fall through
		}
		return "Respuesta inesperada de NASA FIRMS al comprobar la clave.";
	},
};
