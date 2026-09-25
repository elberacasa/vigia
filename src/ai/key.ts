import type { KeySpec } from "../sources/keyspec.ts";

/** TypeSafe (Jev): optional, paid per use; the AI section only. Validated with the free model list. */
export const typesafeKey: KeySpec = {
	id: "typesafe-api-key",
	provider: "TypeSafe",
	name: { es: "Jev (TypeSafe), para la Capa IA", en: "Jev (TypeSafe), for the AI section" },
	cost: "paid",
	unlocks: {
		es: "La clasificación de noticias más precisa (Capa IA): temas, estado y reportes de apagón. Unos US$0,00014 por noticia.",
		en: "The most accurate news classification (AI section): topics, state and blackout reports. About US$0.00014 per item.",
	},
	signupUrl: "https://typesafe.ai",
	minutes: 5,
	steps: {
		es: [
			"Crea una cuenta en typesafe.ai y genera una clave de API.",
			"Pégala aquí. Vigía la verifica con una consulta gratuita (lista de modelos).",
			"En la Capa IA, fija un presupuesto máximo en US$: sin presupuesto, Vigía no hace ninguna consulta de pago.",
		],
		en: [
			"Create an account at typesafe.ai and generate an API key.",
			"Paste it here. Vigía checks it with a free call (the model list).",
			"In the AI section, set a maximum budget in US$: with no budget, Vigía makes no paid request.",
		],
	},
	async validate(key, http) {
		try {
			const res = await http.request("https://api.typesafe.ai/v1/models", {
				headers: { authorization: `Bearer ${key}`, accept: "application/json" },
				retries: 0,
				timeoutMs: 15_000,
			});
			return res.status === 200 ? null : "TypeSafe no aceptó la clave.";
		} catch (error) {
			const status = (error as { status?: number }).status;
			return status === 401 || status === 403
				? "TypeSafe rechazó la clave."
				: "No se pudo contactar a TypeSafe ahora.";
		}
	},
};

/** Anthropic API key: optional, paid per use; only for the written brief in the AI section. */
export const anthropicKey: KeySpec = {
	id: "anthropic-api-key",
	provider: "Anthropic",
	name: {
		es: "Claude (Anthropic), para el resumen escrito",
		en: "Claude (Anthropic), for the written brief",
	},
	cost: "paid",
	unlocks: {
		es: "El resumen del día escrito por Claude (Capa IA), con citas verificadas. Solo cuando lo pides.",
		en: "The daily brief written by Claude (AI section), with checked citations. Only when you ask.",
	},
	signupUrl: "https://console.anthropic.com",
	minutes: 5,
	steps: {
		es: [
			"Crea una clave de API en la consola de Anthropic.",
			"Pégala aquí. Vigía la verifica con una consulta gratuita (lista de modelos).",
			"En la Capa IA, fija un presupuesto: sin presupuesto, no se hace ninguna consulta de pago.",
		],
		en: [
			"Create an API key in the Anthropic console.",
			"Paste it here. Vigía checks it with a free call (the model list).",
			"In the AI section, set a budget: with no budget, no paid request is made.",
		],
	},
	async validate(key, http) {
		try {
			const res = await http.request("https://api.anthropic.com/v1/models", {
				headers: { "x-api-key": key, "anthropic-version": "2023-06-01", accept: "application/json" },
				retries: 0,
				timeoutMs: 15_000,
			});
			return res.status === 200 ? null : "Anthropic no aceptó la clave.";
		} catch (error) {
			const status = (error as { status?: number }).status;
			return status === 401 || status === 403
				? "Anthropic rechazó la clave."
				: "No se pudo contactar a Anthropic ahora.";
		}
	},
};
