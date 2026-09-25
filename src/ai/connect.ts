import { openSettings } from "../config/settings.ts";
import { localPort, localRequest, reasonOf } from "../ops/local-api.ts";
import { ClaudeCodeWriter } from "./brief-writer.ts";

/**
 * `vigia ia conectar | desconectar | estado` (alias `vigia ai connect | disconnect | status`): the one-step way to have
 * the user's own Claude Code write the daily brief.
 *
 * conectar: finds the `claude` command, asks it one trivial question through the same locked-down call the brief
 * uses (ClaudeCodeWriter: no tools, no MCP, --safe-mode, no saved session, an empty folder, a minimal environment),
 * and only if it answers switches the brief backend to "claude-code". The running Vigía is asked to make the change
 * (it saves and applies it at once); with none running, config.json is written here. Nothing else changes: the brief
 * is still written only when the person presses the button on /ia.
 */

export const AI_HELP = `El resumen escrito del día con tu propio Claude Code (tu suscripción, en este equipo):
  vigia ia conectar      Busca «claude», comprueba que tiene sesión y lo elige para el resumen
  vigia ia estado        Muestra qué escribe el resumen y si Claude Code está disponible
  vigia ia desconectar   Vuelve a apagar el resumen escrito
(en inglés: vigia ai connect | status | disconnect)`;

const CHECK_PROMPT = {
	system: "Eres una comprobación de conexión. Responde únicamente con la palabra: listo",
	user: "Responde únicamente con la palabra: listo",
};

export interface AiCliDeps {
	readonly configDir: string;
	readonly out: (line: string) => void;
	readonly err: (line: string) => void;
	readonly which?: (cmd: string) => string | null;
	/** The check call; default: ClaudeCodeWriter with a 90 s limit. */
	readonly probe?: (which: (cmd: string) => string | null) => Promise<string>;
	readonly fetchImpl?: typeof fetch;
}

type Backend = "off" | "anthropic" | "claude-code" | "ollama";

const LABEL: Record<Backend, string> = {
	off: "apagado",
	anthropic: "Claude con tu clave de Anthropic",
	"claude-code": "tu Claude Code",
	ollama: "Ollama (modelo local)",
};

async function setBrief(brief: Backend, argv: readonly string[], deps: AiCliDeps): Promise<string | null> {
	const port = localPort(argv);
	const local = await localRequest(
		{ port, configDir: deps.configDir, method: "POST", path: "/api/ai/settings", body: { brief } },
		deps.fetchImpl,
	).catch(() => ({ running: false as const }));
	if (local.running) {
		if (local.status !== 200)
			return `el Vigía abierto en el puerto ${port} no aceptó el cambio: ${reasonOf(local.body)}`;
		return null;
	}
	openSettings(deps.configDir).setAi({ brief });
	return null;
}

export async function runAiCommand(argv: readonly string[], deps: AiCliDeps): Promise<number> {
	const [sub] = argv;
	const which = deps.which ?? ((cmd: string) => Bun.which(cmd));

	if (sub === "estado" || sub === "status") {
		const current = openSettings(deps.configDir).data.ai.brief;
		const bin = which("claude");
		deps.out(`Resumen escrito: ${LABEL[current]}.`);
		deps.out(bin ? `Claude Code: encontrado en ${bin}.` : "Claude Code: no encontrado en este equipo.");
		if (current !== "claude-code") deps.out("Para usarlo: vigia ia conectar");
		return 0;
	}

	if (sub === "desconectar" || sub === "disconnect") {
		const current = openSettings(deps.configDir).data.ai.brief;
		if (current !== "claude-code") {
			deps.out(
				`Claude Code no estaba conectado (el resumen escrito usa: ${LABEL[current]}). No cambié nada.`,
			);
			return 0;
		}
		const failed = await setBrief("off", argv, deps);
		if (failed) {
			deps.err(`No se pudo desconectar: ${failed}.`);
			return 1;
		}
		deps.out("✓ Desconectado: el resumen escrito está apagado. El resumen hecho por código sigue igual.");
		return 0;
	}

	if (sub !== "conectar" && sub !== "connect") {
		deps.out(AI_HELP);
		return sub === undefined || sub === "help" || sub === "--help" ? 0 : 2;
	}

	const bin = which("claude");
	if (!bin) {
		deps.err(
			"No encontré Claude Code (el comando «claude») en este equipo.\n" +
				"  Instálalo desde https://docs.claude.com/es/docs/claude-code/setup, abre `claude` una vez para iniciar\n" +
				"  sesión, y repite: vigia ia conectar",
		);
		return 1;
	}
	deps.out(`Claude Code encontrado en ${bin}.`);
	deps.out("Comprobando que tiene sesión (una pregunta mínima, sin herramientas ni acceso a tus archivos)…");
	const probe =
		deps.probe ??
		(async (w: (cmd: string) => string | null) =>
			(await new ClaudeCodeWriter(w, 90_000).write(CHECK_PROMPT)).text);
	let answer = "";
	try {
		answer = (await probe(which)).trim();
	} catch (error) {
		deps.err(
			`Claude Code no respondió: ${error instanceof Error ? error.message : String(error)}\n` +
				"  Abre `claude` en una terminal, inicia sesión, y repite: vigia ia conectar. No cambié nada.",
		);
		return 1;
	}
	if (!answer) {
		deps.err("Claude Code respondió vacío. Abre `claude`, revisa tu sesión y repite. No cambié nada.");
		return 1;
	}
	const failed = await setBrief("claude-code", argv, deps);
	if (failed) {
		deps.err(`Claude Code responde, pero no se pudo guardar la opción: ${failed}.`);
		return 1;
	}
	deps.out("✓ Conectado: el resumen escrito del día lo hará tu Claude Code.");
	deps.out("  Se escribe solo cuando pulsas «Escribir» en la página /ia; cada escrito usa tu suscripción.");
	deps.out("  Recibe los titulares públicos y las cifras del resumen, nunca tus claves ni tus archivos.");
	deps.out("  Para apagarlo: vigia ia desconectar");
	return 0;
}
