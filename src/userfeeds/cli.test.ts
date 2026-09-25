import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSettings } from "../config/settings.ts";
import { runTelegramCommand, type TelegramCliDeps } from "./cli.ts";
import { type Resolver, SafeHttp } from "./net.ts";

const PREVIEW = `<html><body><div class="tgme_channel_info"><div class="tgme_channel_info_header_title"><span>Canal Ejemplo</span></div></div>
<section class="tgme_channel_history"><div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="canalejemplo/3">
<div class="tgme_widget_message_text">Aviso de prueba</div>
<a class="tgme_widget_message_date" href="https://t.me/canalejemplo/3"><time datetime="2026-09-24T16:00:00+00:00">16:00</time></a>
</div></div></section></body></html>`;

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function deps() {
	const configDir = mkdtempSync(join(tmpdir(), "vigia-tg-cli-"));
	dirs.push(configDir);
	const out: string[] = [];
	const err: string[] = [];
	const resolve: Resolver = async (host) => (host === "t.me" ? ["149.154.167.99"] : []);
	const calls: string[] = [];
	const http = new SafeHttp({
		resolve,
		hostGapMs: 0,
		fetchImpl: (async (input: string | URL | Request) => {
			calls.push(new URL(String(input)).pathname);
			return new Response(PREVIEW, { status: 200, headers: { "content-type": "text/html" } });
		}) as typeof fetch,
	});
	const d: TelegramCliDeps = {
		configDir,
		out: (l) => void out.push(l),
		err: (l) => void err.push(l),
		http,
		fetchImpl: (async () => {
			throw new Error("connection refused");
		}) as unknown as typeof fetch,
	};
	return { d, out, err, configDir, calls };
}

describe("vigia telegram", () => {
	test("add with no Vigía running: reads the preview once and saves it to config.json", async () => {
		const { d, out, configDir, calls } = deps();
		expect(await runTelegramCommand(["add", "t.me/CanalEjemplo", "--cubre", "VE-V", "--cada", "60"], d)).toBe(
			0,
		);
		expect(calls).toEqual(["/s/canalejemplo"]);
		const [feed] = openSettings(configDir).data.userFeeds;
		expect(feed).toMatchObject({
			url: "https://t.me/s/canalejemplo",
			name: "Canal Ejemplo",
			region: "VE-V",
			intervalMin: 60,
		});
		expect(out.join("\n")).toContain("lo leerá al iniciar");
		const listed: string[] = [];
		await runTelegramCommand(["list"], { ...d, out: (l) => void listed.push(l) });
		expect(listed.join("\n")).toContain("@canalejemplo");
	});
	test("refuses invite links and bad intervals before any request", async () => {
		const { d, calls } = deps();
		expect(await runTelegramCommand(["add", "https://t.me/+abc"], d)).toBe(2);
		expect(await runTelegramCommand(["add", "@canalejemplo", "--cada", "5"], d)).toBe(2);
		expect(calls).toEqual([]);
	});
	test("no arguments prints the help", async () => {
		const { d, out } = deps();
		expect(await runTelegramCommand([], d)).toBe(0);
		expect(out.join("\n")).toContain("vigia telegram add <canal>");
	});
});
