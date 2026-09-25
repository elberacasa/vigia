import { formatWithOptions } from "node:util";

/**
 * Structured logs for operators (`--log json` or VIGIA_LOG_FORMAT=json): one JSON object per line on stdout/stderr,
 * `{"ts":"…","level":"info|warn|error","component":"feed","msg":"…"}`, so journald, Docker or a log shipper can
 * parse them. Vigía's code logs with console.log/warn/error and a "[component]" prefix; in JSON mode those calls are
 * rewritten here, so no call site changes.
 *
 * Visitors are never logged: no request lines, no addresses. A public mirror's logs could otherwise name who read
 * what.
 */

export type Level = "info" | "warn" | "error";

export interface LogLine {
	readonly ts: string;
	readonly level: Level;
	readonly component: string;
	readonly msg: string;
}

/** Turns one console call's arguments into a structured line. Pure; exported for tests. */
export function toLine(level: Level, args: readonly unknown[], now: number): LogLine {
	const text = formatWithOptions({ colors: false, breakLength: Number.POSITIVE_INFINITY }, ...args);
	const tagged = /^\[([\w .-]{1,40})\]\s*(.*)$/s.exec(text);
	return {
		ts: new Date(now).toISOString(),
		level,
		component: tagged?.[1]?.trim() ?? "vigia",
		msg: (tagged?.[2] ?? text).slice(0, 4_000),
	};
}

let installed = false;

/** Switches console output to JSON lines for the rest of the process. Idempotent. */
export function useJsonLogs(write: (stream: "out" | "err", line: string) => void = defaultWrite): void {
	if (installed) return;
	installed = true;
	const emit =
		(level: Level, stream: "out" | "err") =>
		(...args: unknown[]) =>
			write(stream, `${JSON.stringify(toLine(level, args, Date.now()))}\n`);
	console.log = emit("info", "out");
	console.info = emit("info", "out");
	console.warn = emit("warn", "err");
	console.error = emit("error", "err");
}

function defaultWrite(stream: "out" | "err", line: string): void {
	(stream === "out" ? process.stdout : process.stderr).write(line);
}
