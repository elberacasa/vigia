import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyStore } from "../config/keys.ts";
import { loadSessionToken } from "../config/session.ts";
import { openSettings } from "../config/settings.ts";
import { Scheduler } from "../core/scheduler.ts";
import { Store } from "../core/store.ts";
import type { HttpLike } from "../core/types.ts";
import { createApp } from "../server/app.ts";
import { PanelCache } from "../server/panels.ts";
import { ClaudeCodeWriter } from "./brief-writer.ts";
import { type AiCliDeps, runAiCommand } from "./connect.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const noServer = (async () => {
	throw new Error("connection refused");
}) as unknown as typeof fetch;

function deps(over: Partial<AiCliDeps> = {}) {
	const configDir = mkdtempSync(join(tmpdir(), "vigia-ai-cli-"));
	dirs.push(configDir);
	const out: string[] = [];
	const err: string[] = [];
	const d: AiCliDeps = {
		configDir,
		out: (l) => void out.push(l),
		err: (l) => void err.push(l),
		which: (cmd) => (cmd === "claude" ? "/usr/local/bin/claude" : null),
		probe: async () => "listo",
		fetchImpl: noServer,
		...over,
	};
	return { d, out, err, configDir };
}

/** A real app on "this machine": requests arrive from 127.0.0.1 and pass through the real write guard. */
function running(configDir: string, onAi: (brief: unknown) => void): typeof fetch {
	const store = new Store(":memory:");
	const offline: HttpLike = {
		request: async () => {
			throw new Error("offline");
		},
	};
	const keys: KeyStore = {
		get: () => undefined,
		has: () => false,
		set: () => {},
		remove: () => {},
		origin: () => null,
	};
	const now = () => Date.UTC(2026, 8, 25, 18);
	const app = createApp({
		store,
		scheduler: new Scheduler([], { store, http: offline, key: () => undefined, now }),
		adapters: [],
		keys,
		keySpecs: [],
		panels: new PanelCache([], store, now),
		http: offline,
		version: "test",
		sessionToken: loadSessionToken(configDir),
		setAi: (next) => onAi(next.brief),
		now,
	});
	return (async (input: string | URL | Request, init?: RequestInit) =>
		app.fetch(new Request(String(input), init), "127.0.0.1")) as typeof fetch;
}

describe("vigia ia conectar", () => {
	test("with no Vigía running: checks Claude Code, then writes config.json", async () => {
		const { d, out, configDir } = deps();
		expect(await runAiCommand(["conectar"], d)).toBe(0);
		expect(openSettings(configDir).data.ai.brief).toBe("claude-code");
		expect(out.join("\n")).toContain("vigia ia desconectar");
	});
	test("with Vigía running: the change goes through its API with this machine's session, so it is not overwritten", async () => {
		const { d, configDir } = deps();
		const seen: unknown[] = [];
		const code = await runAiCommand(["connect", "--port", "7799"], {
			...d,
			fetchImpl: running(configDir, (b) => seen.push(b)),
		});
		expect(code).toBe(0);
		expect(seen).toEqual(["claude-code"]);
		// The server owns config.json while it runs.
		expect(openSettings(configDir).data.ai.brief).toBe("off");
	});
	test("no claude command: explains how to install, changes nothing", async () => {
		const { d, err, configDir } = deps({ which: () => null });
		expect(await runAiCommand(["conectar"], d)).toBe(1);
		expect(err.join("\n")).toContain("No encontré Claude Code");
		expect(openSettings(configDir).data.ai.brief).toBe("off");
	});
	test("claude not logged in (the check fails or answers empty): changes nothing", async () => {
		for (const probe of [async () => Promise.reject(new Error("sin sesión")), async () => "  "]) {
			const { d, configDir } = deps({ probe });
			expect(await runAiCommand(["conectar"], d)).toBe(1);
			expect(openSettings(configDir).data.ai.brief).toBe("off");
		}
	});
	test("the check uses the brief's locked-down call (no tools, safe mode, no MCP, no saved session)", () => {
		const args = ClaudeCodeWriter.args("/bin/claude", "x");
		for (const a of ["-p", "--safe-mode", "--strict-mcp-config", "--no-session-persistence"])
			expect(args).toContain(a);
		expect(args[args.indexOf("--tools") + 1]).toBe("");
	});
});

describe("vigia ia desconectar / estado", () => {
	test("desconectar turns off only Claude Code", async () => {
		const { d, configDir } = deps();
		openSettings(configDir).setAi({ brief: "ollama" });
		expect(await runAiCommand(["desconectar"], d)).toBe(0);
		expect(openSettings(configDir).data.ai.brief).toBe("ollama");
		openSettings(configDir).setAi({ brief: "claude-code" });
		expect(await runAiCommand(["disconnect"], d)).toBe(0);
		expect(openSettings(configDir).data.ai.brief).toBe("off");
	});
	test("estado says what writes the brief and whether claude is here", async () => {
		const { d, out } = deps();
		expect(await runAiCommand(["estado"], d)).toBe(0);
		expect(out.join("\n")).toContain("Resumen escrito: apagado.");
		expect(out.join("\n")).toContain("/usr/local/bin/claude");
	});
	test("unknown subcommand prints help with exit 2", async () => {
		const { d, out } = deps();
		expect(await runAiCommand(["foo"], d)).toBe(2);
		expect(out.join("\n")).toContain("vigia ia conectar");
	});
});
