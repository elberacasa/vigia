#!/usr/bin/env bun
import pkg from "../package.json" with { type: "json" };
import { ADAPTERS } from "./adapters/registry.ts";
import { openKeyStore } from "./config/keys.ts";
import { resolvePaths } from "./config/paths.ts";
import { HttpClient } from "./core/http.ts";

const HELP = `Vigía ${pkg.version}: sala de situación abierta de Venezuela

Uso:
  vigia                 Inicia Vigía y abre http://localhost:7722
  vigia --version       Muestra la versión
  vigia --port 8080     Otro puerto
  vigia --host 0.0.0.0  Acepta conexiones de tu red local (las claves solo se cambian desde este equipo)
  vigia --no-open       No abre el navegador
  vigia --no-fetch      Muestra lo guardado sin consultar ninguna fuente (para trabajar en el diseño)
  vigia fetch <fuente>  Consulta una fuente una vez y muestra el resultado
  vigia sources         Lista las fuentes y si necesitan clave
  vigia paths           Muestra dónde se guardan datos y claves
  vigia verify          Comprueba que el archivo sellado no cambió (cadena de resúmenes SHA-256)
  vigia verify <archivo>  Comprueba un archivo de evidencia guardado desde Vigía
  vigia status          Imprime la situación actual desde un Vigía en marcha (--port, --color, --lang en)
  vigia backup [archivo]  Copia verificada del archivo (observaciones y cadena sellada); sin claves
  vigia restore <archivo> Restaura una copia (con Vigía cerrado), la verifica y guarda aparte la anterior
  vigia healthcheck     Sale con 0 si el Vigía de este equipo responde (Docker, systemd, monitoreo)

Despliegue (también por variables de entorno, ver docs/OPERATIONS.md):
  --public              Espejo público de solo lectura (VIGIA_MODE=public): toda escritura desactivada
  --cors                Permite leer /api/v1 desde otras páginas (VIGIA_CORS=1; activo en --public)
  --metrics <m>         Quién lee /metrics: loopback (por defecto), open u off (VIGIA_METRICS)
  --log json            Registro en líneas JSON (VIGIA_LOG_FORMAT=json)
  --trust-proxy         Detrás de un proxy en este equipo: toma el cliente de X-Forwarded-For (VIGIA_TRUST_PROXY=1)
  VIGIA_BCV_API=0       Apaga la segunda vía a la tasa del BCV (bcv-api, el servicio público del mantenedor)
`;

async function main(argv: string[]): Promise<number> {
	const [command] = argv;
	if (argv.includes("--help") || argv.includes("-h") || command === "help") {
		console.log(HELP);
		return 0;
	}
	if (command === "--version" || command === "-v" || command === "version") {
		console.log(`vigia ${pkg.version}`);
		return 0;
	}

	if (command === "paths") {
		const p = resolvePaths();
		console.log(`Configuración y claves: ${p.config}\nDatos: ${p.data}`);
		return 0;
	}

	if (command === "sources") {
		const keys = openKeyStore(resolvePaths().config);
		for (const a of ADAPTERS) {
			const missing = a.keys.filter((k) => !keys.has(k));
			const state =
				a.keys.length === 0 ? "abierta" : missing.length ? `falta ${missing.join(", ")}` : "con clave";
			console.log(`${a.id.padEnd(28)} ${a.provider.padEnd(22)} ${state}`);
		}
		return 0;
	}

	if (command === "backup" || command === "restore") {
		const { join } = await import("node:path");
		const { backup, restore } = await import("./ops/backup.ts");
		const dbPath = join(resolvePaths().data, "vigia.sqlite");
		const out = (line: string) => console.log(line);
		if (command === "backup") {
			const dest = argv[1] && !argv[1].startsWith("--") ? argv[1] : undefined;
			const made = backup({ dbPath, version: pkg.version, out, ...(dest ? { dest } : {}) });
			if (!made) return 1;
			const mb = (made.manifest.bytes / 1_048_576).toFixed(1);
			console.log(
				`✓ Respaldo verificado en ${made.path} (${mb} MB, ${made.manifest.tables.obs ?? 0} observaciones, ${made.manifest.sealedDays} días sellados, ${made.ms} ms)\n  Manifiesto: ${made.path}.json\n  Las claves y ajustes no se copian (están en ${resolvePaths().config}).`,
			);
			return 0;
		}
		const file = argv[1];
		if (!file || file.startsWith("--")) {
			console.error("Indica el archivo: vigia restore <respaldo.sqlite>");
			return 1;
		}
		const result = restore({
			file,
			dbPath,
			force: argv.includes("--force"),
			forceReplaceSealed: argv.includes("--force-replace-sealed"),
			out,
		});
		if (result.code === 0) console.log(`Listo en ${result.ms} ms.`);
		return result.code;
	}

	if (command === "healthcheck") {
		// For container and service health checks: this machine's Vigía answers its API within 4 s.
		const { loadConfig } = await import("./server/config.ts");
		try {
			const { port } = loadConfig(argv.slice(1));
			const res = await fetch(`http://127.0.0.1:${port}/api/v1`, { signal: AbortSignal.timeout(4_000) });
			return res.ok ? 0 : 1;
		} catch {
			return 1;
		}
	}

	if (command === "verify" || command === "status") {
		const { runIntelCommand } = await import("./intel/commands.ts");
		return runIntelCommand(command, argv.slice(1));
	}

	if (command === "fetch") {
		const id = argv[1];
		const adapter = ADAPTERS.find((a) => a.id === id);
		if (!adapter) {
			console.error(`Fuente desconocida: ${id ?? "(ninguna)"}. Usa "vigia sources".`);
			return 1;
		}
		const keys = openKeyStore(resolvePaths().config);
		const started = performance.now();
		const raws = await adapter.fetch({
			http: new HttpClient(),
			key: (k) => keys.get(k),
			now: Date.now,
			signal: new AbortController().signal,
		});
		const observations = adapter.normalise(raws);
		const ms = Math.round(performance.now() - started);
		const bytes = raws.reduce((s, r) => s + r.body.length, 0);
		console.log(`${adapter.id}: ${observations.length} observaciones, ${bytes} bytes, ${ms} ms`);
		for (const o of observations.slice(0, 5)) {
			console.log(
				`  ${new Date(o.observedAt).toISOString()} ${o.series} ${JSON.stringify(o.value).slice(0, 140)}`,
			);
		}
		return 0;
	}

	if (command && !command.startsWith("--")) {
		console.error(`Comando desconocido: ${command}\n\n${HELP}`);
		return 1;
	}

	const { ConfigError, loadConfig, unknownOptions } = await import("./server/config.ts");
	const unknown = unknownOptions(argv);
	if (unknown.length > 0) {
		console.error(`Opción desconocida: ${unknown.join(" ")}\nAyuda: vigia --help`);
		return 2;
	}
	let config: ReturnType<typeof loadConfig>;
	try {
		config = loadConfig(argv);
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		console.error(`Configuración no válida: ${error.message}\nAyuda: vigia --help`);
		return 2;
	}
	const { port, host } = config;
	if (config.logFormat === "json") (await import("./server/log.ts")).useJsonLogs();
	const { serve } = await import("./server/main.ts");
	let running: Awaited<ReturnType<typeof serve>>;
	try {
		running = await serve({
			port,
			host,
			version: pkg.version,
			noFetch: config.noFetch,
			deploy: config,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/EADDRINUSE|in use/i.test(message)) {
			console.error(
				`El puerto ${port} está ocupado. ¿Ya hay un Vigía abierto? Prueba: vigia --port ${port + 1}`,
			);
		} else {
			console.error(`No se pudo iniciar Vigía: ${message}`);
		}
		return 1;
	}
	const base = `http://${host === "0.0.0.0" ? "localhost" : host === "127.0.0.1" ? "localhost" : host}:${port}`;
	// The token in this link is what lets this browser change keys and settings (config/session.ts). A public
	// mirror never prints it: nothing there can be changed from a browser.
	const url = config.mode === "public" ? `${base}/` : `${base}/?token=${running.sessionToken}`;
	console.log(
		config.mode === "public"
			? `\n  Vigía ${pkg.version}, espejo público de solo lectura, en ${url}\n  API: ${base}/api  ·  Datos en ${running.paths.data}\n`
			: `\n  Vigía ${pkg.version} está en ${url}\n  (abre este enlace para poder cambiar claves y ajustes; no lo compartas)\n  Datos en ${running.paths.data}\n  Ctrl+C para salir.\n`,
	);
	if (!config.noOpen) openBrowser(url);

	let stopping = false;
	const shutdown = () => {
		if (stopping) return;
		stopping = true;
		const started = Date.now();
		void running.stop().then(() => {
			console.log(`[vigia] cerrado en ${Date.now() - started} ms`);
			process.exit(0);
		});
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	return await new Promise<number>(() => {});
}

function openBrowser(url: string): void {
	const cmd =
		process.platform === "win32"
			? ["cmd", "/c", "start", "", url]
			: process.platform === "darwin"
				? ["open", url]
				: ["xdg-open", url];
	try {
		Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).unref();
	} catch {
		// No desktop: the URL is printed above.
	}
}

process.exitCode = await main(process.argv.slice(2));
