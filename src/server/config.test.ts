import { expect, test } from "bun:test";
import { ConfigError, clientAddress, loadConfig, unknownOptions } from "./config.ts";
import { toLine, useJsonLogs } from "./log.ts";

test("defaults: local mode on loopback, CORS off, metrics for this machine, text logs", () => {
	expect(loadConfig([], {})).toEqual({
		mode: "local",
		port: 7722,
		host: "127.0.0.1",
		cors: false,
		metrics: "loopback",
		logFormat: "text",
		trustProxy: [],
		noFetch: false,
		noOpen: false,
	});
});

test("public mode turns CORS on and never opens a browser; flags win over the environment", () => {
	const c = loadConfig(["--public", "--port", "8080"], { VIGIA_PORT: "9000", VIGIA_CORS: "" });
	expect(c).toMatchObject({ mode: "public", port: 8080, cors: true, noOpen: true });
	expect(loadConfig([], { VIGIA_MODE: "public", VIGIA_CORS: "0" }).cors).toBe(false);
	expect(loadConfig(["--mode", "local"], { VIGIA_MODE: "public" }).mode).toBe("local");
	expect(
		loadConfig(["--metrics", "open", "--log", "json", "--trust-proxy", "--no-fetch"], {
			VIGIA_METRICS: "off",
		}),
	).toMatchObject({ metrics: "open", logFormat: "json", trustProxy: ["loopback"], noFetch: true });
	expect(loadConfig([], { VIGIA_NO_FETCH: "1", VIGIA_TRUST_PROXY: "sí" })).toMatchObject({
		noFetch: true,
		trustProxy: ["loopback"],
	});
});

test("invalid settings fail at start with a clear Spanish message", () => {
	const cases: [readonly string[], Record<string, string>, RegExp][] = [
		[[], { VIGIA_MODE: "publico" }, /modo .*«local» o «public».*«publico»/],
		[["--port", "0"], {}, /Puerto no válido: «0»/],
		[["--port", "80a"], {}, /Puerto no válido/],
		[["--port"], {}, /Falta el valor de --port/],
		[["--metrics", "all"], {}, /métricas.*«off» o «loopback» o «open»/],
		[[], { VIGIA_LOG_FORMAT: "xml" }, /formato de registro/],
		[[], { VIGIA_CORS: "maybe" }, /VIGIA_CORS debe ser 1 o 0/],
		[["--host", "a b"], {}, /Dirección no válida/],
	];
	for (const [args, env, message] of cases) {
		let caught: unknown = null;
		try {
			loadConfig(args, env);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ConfigError);
		expect((caught as Error).message).toMatch(message);
	}
});

test("the client address comes from X-Forwarded-For only behind a trusted local proxy, last entry only", () => {
	const local = ["loopback"];
	expect(clientAddress("127.0.0.1", "198.51.100.7", [])).toBe("127.0.0.1");
	expect(clientAddress("127.0.0.1", "198.51.100.7", local)).toBe("198.51.100.7");
	// A client-supplied first entry is ignored: the proxy appends the real peer last.
	expect(clientAddress("127.0.0.1", "127.0.0.1, 198.51.100.7", local)).toBe("198.51.100.7");
	// A peer that is not a trusted proxy cannot claim to be someone else.
	expect(clientAddress("203.0.113.9", "127.0.0.1", local)).toBe("203.0.113.9");
	expect(clientAddress("::1", "garbage<>", local)).toBe("::1");
	expect(clientAddress("127.0.0.1", null, local)).toBe("127.0.0.1");
	// A proxy in another container: a Docker network range.
	const docker = loadConfig([], { VIGIA_TRUST_PROXY: "172.16.0.0/12, fd00::1" }).trustProxy;
	expect(docker).toEqual(["172.16.0.0/12", "fd00::1"]);
	expect(clientAddress("172.18.0.5", "198.51.100.7", docker)).toBe("198.51.100.7");
	expect(clientAddress("::ffff:172.31.255.1", "198.51.100.8", docker)).toBe("198.51.100.8");
	expect(clientAddress("172.32.0.1", "198.51.100.7", docker)).toBe("172.32.0.1");
	expect(clientAddress("fd00::1", "198.51.100.9", docker)).toBe("198.51.100.9");
	expect(() => loadConfig([], { VIGIA_TRUST_PROXY: "172.16.0.0/40" })).toThrow(/no es una dirección/);
	expect(() => loadConfig([], { VIGIA_TRUST_PROXY: "proxy.local" })).toThrow(ConfigError);
});

test("JSON logs: one object per line, component from the [tag] prefix, never an address unless logged", () => {
	expect(toLine("info", ["[feed] [usgs-quakes] 12 observaciones"], Date.UTC(2026, 8, 24, 12))).toEqual({
		ts: "2026-09-24T12:00:00.000Z",
		level: "info",
		component: "feed",
		msg: "[usgs-quakes] 12 observaciones",
	});
	expect(toLine("error", ["[server]", new Error("boom").message], 0)).toMatchObject({
		component: "server",
		msg: "boom",
	});
	expect(toLine("warn", ["sin etiqueta", { a: 1 }], 0)).toMatchObject({
		component: "vigia",
		msg: "sin etiqueta { a: 1 }",
	});
	const lines: string[] = [];
	const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
	try {
		useJsonLogs((_stream, line) => lines.push(line));
		console.log("[vigia] listo");
		console.error("[server]", "falló");
	} finally {
		Object.assign(console, original);
	}
	expect(lines.map((l) => JSON.parse(l))).toMatchObject([
		{ level: "info", component: "vigia", msg: "listo" },
		{ level: "error", component: "server", msg: "falló" },
	]);
	expect(lines.every((l) => l.endsWith("\n"))).toBe(true);
});

test("an unknown option is reported instead of starting silently with the defaults (a typo like --prot)", () => {
	expect(unknownOptions(["--port", "8080", "--no-open", "--no-fetch", "--host", "0.0.0.0"])).toEqual([]);
	expect(
		unknownOptions(["--public", "--cors", "--trust-proxy", "--metrics", "open", "--log", "json"]),
	).toEqual([]);
	expect(unknownOptions(["--dev", "--mode", "public"])).toEqual([]);
	expect(unknownOptions(["--prot", "8080"])).toEqual(["--prot", "8080"]);
	expect(unknownOptions(["--no-open", "--nofetch"])).toEqual(["--nofetch"]);
});
