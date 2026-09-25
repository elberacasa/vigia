/**
 * CLI commands of the intelligence layer: `vigia verify [file]` and `vigia status`. Plain Spanish output. Exit
 * codes: 0 checked out, 1 failed, 2 (a bundle) coherent but not anchored to any sealed archive on this machine.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths } from "../config/paths.ts";
import { Store } from "../core/store.ts";
import { localArchive, verifyBundle } from "./bundle.ts";
import { chain, verifyChain } from "./chain.ts";
import { clean } from "./text.ts";

type Out = (line: string) => void;

function openLocal(): Store | null {
	const file = join(resolvePaths().data, "vigia.sqlite");
	return existsSync(file) ? new Store(file) : null;
}

/** `vigia verify`: recomputes every sealed day of this machine's archive. */
export function verifyArchive(store: Store, out: Out): number {
	const days = verifyChain(store);
	if (days.length === 0) {
		out("Todavía no hay días sellados: Vigía sella cada día UTC una hora después de que termina.");
		return 0;
	}
	const bad = days.filter((d) => !d.ok);
	for (const d of days) {
		const pruned = d.pruned ? `  (${d.pruned} borradas por la retención configurada)` : "";
		out(clean(`${d.ok ? "✓" : "✗"} ${d.day}  ${d.rowsNow} filas${d.ok ? pruned : `  ${d.problem}`}`));
	}
	const head = chain(store).at(-1);
	out("");
	out(
		bad.length === 0
			? `Archivo coherente: ${days.length} días sellados coinciden con la cadena guardada en este equipo.`
			: `${bad.length} de ${days.length} días no coinciden con lo sellado.`,
	);
	if (head) {
		out(clean(`Cabeza de la cadena (${head.day}): ${head.digest}`));
		// The chain lives on this machine: whoever controls it could rebuild it. A copy kept elsewhere cannot.
		out(
			"Compare esa cabeza con una copia guardada fuera de este equipo: solo así se descarta que la rehicieran.",
		);
	}
	return bad.length === 0 ? 0 : 1;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** `vigia verify <file>`: checks an evidence bundle offline, and against this machine's archive when present. */
export function verifyFile(path: string, store: Store | null, out: Out): number {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		out(clean(`No se pudo leer ${path}: ${error instanceof Error ? error.message : error}`));
		return 1;
	}
	let report: ReturnType<typeof verifyBundle>;
	try {
		report = verifyBundle(raw, store ? localArchive(store) : undefined);
	} catch {
		out("El archivo no tiene la forma de una evidencia de Vigía.");
		return 1;
	}
	const b = raw as {
		subject?: { title?: unknown };
		createdAt?: unknown;
		chain?: { entries?: { day?: unknown; digest?: unknown }[] };
	};
	if (typeof b.subject?.title === "string") out(`Evidencia: ${clean(b.subject.title.slice(0, 500))}`);
	if (typeof b.createdAt === "number" && Number.isFinite(b.createdAt) && Math.abs(b.createdAt) < 8.64e15)
		out(`Guardada: ${new Date(b.createdAt).toISOString()} (UTC)`);
	if (report.readable) out(`${report.fileHashOk ? "✓" : "✗"} Huella del archivo (sha256)`);
	if (report.proven)
		out(
			`✓ ${plural(report.proven, "observación probada", "observaciones probadas")} contra el resumen sellado de su día`,
		);
	if (report.anchored)
		out(`✓ ${plural(report.anchored, "comprobada", "comprobadas")} contra el archivo sellado de este equipo`);
	if (report.withheld)
		out(
			`· ${report.withheld} sin valor por la licencia de su fuente: se prueban todos sus campos y la huella del valor, no el valor (véase su enlace)`,
		);
	if (report.unproven)
		out(
			`· ${plural(report.unproven, "observación sin prueba", "observaciones sin prueba")} que este equipo no puede comprobar (su día no estaba sellado al guardarla, o no está sellado aquí): vuelva a guardar la evidencia después de la 01:00 UTC del día siguiente`,
		);
	for (const l of report.local) {
		const text = {
			same: "coincide con la cadena guardada en este equipo",
			different: "NO coincide con el archivo de este equipo",
			absent: "este equipo no tiene ese día sellado",
			"sealed-here":
				"el archivo no trae su resumen; este equipo lo selló y lo comprueba con su propio archivo",
			unchecked: "no hay archivo local para comparar",
		}[l.status];
		out(clean(`${l.status === "different" ? "✗" : l.status === "same" ? "✓" : "·"} Día ${l.day}: ${text}`));
	}
	for (const p of report.problems) out(`✗ ${clean(p)}`);
	out("");
	if (!report.ok) {
		out("La evidencia NO es íntegra.");
		return 1;
	}
	if (report.total > 0 && report.anchored === report.total) {
		out("La evidencia es íntegra y coincide con la cadena guardada en este equipo.");
		return 0;
	}
	const unchecked = report.total - report.anchored;
	out(
		store
			? `Coherente, pero NO comprobada del todo: ${plural(unchecked, "observación", "observaciones")} de ${report.total} sin comprobar contra el archivo sellado de este equipo.`
			: `Coherente, pero NO comprobada: no hay un archivo de Vigía en este equipo (${plural(unchecked, "observación", "observaciones")} sin comprobar). Cualquiera puede fabricar un archivo coherente:`,
	);
	const digests = (b.chain?.entries ?? []).filter(
		(e): e is { day: string; digest: string } => typeof e.day === "string" && typeof e.digest === "string",
	);
	if (digests.length) {
		out(
			"compare estos resúmenes con /api/archive/digests de la instancia que la generó, o con una copia guardada:",
		);
		for (const e of digests) out(`  ${clean(e.day.slice(0, 20))}  ${clean(e.digest.slice(0, 64))}`);
	}
	return 2;
}

function flag(args: readonly string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
}

/**
 * `vigia status`: the text report from a running instance (the same as `curl localhost:7722`). Colour when printing
 * to a terminal (unless NO_COLOR or --no-color), or with --color.
 */
export async function status(
	args: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
	isTty: boolean,
	write: (text: string) => void,
	fetcher: typeof fetch = fetch,
): Promise<number> {
	const port = Number(flag(args, "--port") ?? env.VIGIA_PORT ?? 7722);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		write(`Puerto no válido: ${port}\n`);
		return 1;
	}
	const color =
		args.includes("--color") || (isTty && !args.includes("--no-color") && env.NO_COLOR === undefined);
	const lang = flag(args, "--lang") === "en" ? "en" : "es";
	const url = `http://localhost:${port}/ahora.txt?lang=${lang}${color ? "&color=1" : ""}`;
	try {
		const res = await fetcher(url, {
			headers: { "user-agent": "vigia-cli" },
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) {
			write(`Vigía respondió ${res.status} en ${url}\n`);
			return 1;
		}
		write(await res.text());
		return 0;
	} catch {
		write(
			`No hay un Vigía en marcha en http://localhost:${port}. Inícialo con: vigia${port === 7722 ? "" : ` --port ${port}`}\n`,
		);
		return 1;
	}
}

export async function runIntelCommand(command: string, args: readonly string[]): Promise<number> {
	const out: Out = (line) => console.log(line);
	if (command === "status")
		return status(args, process.env, Boolean(process.stdout.isTTY), (text) => process.stdout.write(text));
	if (command === "verify") {
		const store = openLocal();
		try {
			const [file] = args;
			if (file) return verifyFile(file, store, out);
			if (!store) {
				out(`No hay archivo local en ${resolvePaths().data}.`);
				return 1;
			}
			return verifyArchive(store, out);
		} finally {
			store?.close();
		}
	}
	out(`Comando desconocido: ${command}`);
	return 1;
}
