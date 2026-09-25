import { loadSessionToken, sessionCookieName } from "../config/session.ts";

/**
 * Talks to the Vigía running on this machine, as the person at the terminal: the CLI reads the same 0600 session
 * token `vigia enlace` prints and sends it as the session cookie, from loopback with a loopback Host and Origin, so
 * the server's write guard (src/server/app.ts) treats it like the browser opened from the terminal's link.
 *
 * A change made this way takes effect at once (the running server saves it and schedules it). When no Vigía answers,
 * callers write config.json themselves; writing it while a server runs would be overwritten by the server's next
 * save, which is why the running server is always asked first.
 */

export type LocalResult =
	| { readonly running: false }
	| { readonly running: true; readonly status: number; readonly body: unknown };

export function localPort(argv: readonly string[]): number {
	const at = argv.indexOf("--port");
	const raw = (at === -1 ? undefined : argv[at + 1]) ?? process.env.VIGIA_PORT ?? "7722";
	const port = Number(raw);
	return Number.isInteger(port) && port > 0 && port < 65_536 ? port : 7722;
}

export async function isRunning(port: number, fetchImpl: typeof fetch = fetch): Promise<boolean> {
	return fetchImpl(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) })
		.then((r) => r.ok)
		.catch(() => false);
}

export async function localRequest(
	options: {
		readonly port: number;
		readonly configDir: string;
		readonly method: "GET" | "POST";
		readonly path: string;
		readonly body?: unknown;
		readonly timeoutMs?: number;
	},
	fetchImpl: typeof fetch = fetch,
): Promise<LocalResult> {
	if (!(await isRunning(options.port, fetchImpl))) return { running: false };
	const token = loadSessionToken(options.configDir);
	// 127.0.0.1 in the URL makes the Host header loopback, and the Origin names the same host, as a browser's would.
	const origin = `http://127.0.0.1:${options.port}`;
	const res = await fetchImpl(`${origin}${options.path}`, {
		method: options.method,
		headers: {
			origin,
			"content-type": "application/json",
			cookie: `${sessionCookieName(token)}=${token}`,
		},
		...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
		signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
	});
	return { running: true, status: res.status, body: await res.json().catch(() => null) };
}

/** The error text a refusal carries ({error} or {reason}), for printing without its final period. */
export function reasonOf(body: unknown): string {
	if (body && typeof body === "object") {
		const b = body as Record<string, unknown>;
		// The browser's wording ("este navegador…") does not fit a terminal: the token read here is another instance's.
		if (b.code === "session")
			return "no reconoce la sesión de esta terminal (¿se inició con otra carpeta de datos, VIGIA_HOME, o como otro usuario?)";
		for (const k of ["reason", "error", "detail", "title"])
			if (typeof b[k] === "string") return (b[k] as string).replace(/\.+$/, "");
	}
	return "respuesta inesperada";
}
