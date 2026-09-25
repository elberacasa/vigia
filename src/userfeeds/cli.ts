import { previewHandle, telegramHandle } from "../adapters/telegram/parse.ts";
import { openSettings } from "../config/settings.ts";
import { localPort, localRequest, reasonOf } from "../ops/local-api.ts";
import { SafeHttp } from "./net.ts";
import { USER_FEED_INTERVALS_MIN, type UserFeed } from "./schema.ts";
import { UserFeeds } from "./service.ts";

/**
 * `vigia telegram add <canal>` and `vigia telegram list`: the terminal side of "Mis fuentes › Canal de Telegram".
 * A running Vigía is asked first (it checks, reads and schedules the channel at once); with none running, the channel
 * is checked and read the same way here and saved to config.json for the next start.
 */

export const TELEGRAM_HELP = `Canales públicos de Telegram en «Mis fuentes» (solo en este equipo):
  vigia telegram add <canal>   Añade un canal: @nombre, nombre o t.me/nombre
      --cubre <VE-X|national|international>   Estado o alcance que cubre (por defecto: national)
      --cada <15|30|60|180>                   Minutos entre lecturas (por defecto: 30)
  vigia telegram list          Lista los canales añadidos
Solo canales públicos: los enlaces de invitación (t.me/+…) son privados y no se aceptan.`;

export interface TelegramCliDeps {
	readonly configDir: string;
	readonly out: (line: string) => void;
	readonly err: (line: string) => void;
	readonly fetchImpl?: typeof fetch;
	readonly http?: SafeHttp;
}

function flag(argv: readonly string[], name: string): string | undefined {
	const at = argv.indexOf(name);
	return at === -1 ? undefined : argv[at + 1];
}

function describe(feed: UserFeed): string {
	const handle = previewHandle(feed.url);
	return `${feed.name} (@${handle ?? "?"}, cada ${feed.intervalMin} min, ${feed.region})`;
}

export async function runTelegramCommand(argv: readonly string[], deps: TelegramCliDeps): Promise<number> {
	const [sub, target] = argv;
	if (sub === "list" || sub === "ls") {
		const channels = openSettings(deps.configDir).data.userFeeds.filter((f) => previewHandle(f.url));
		if (!channels.length) deps.out("Aún no añadiste ningún canal de Telegram.");
		for (const f of channels) deps.out(`  ${describe(f)}`);
		return 0;
	}
	if (sub !== "add" || !target || target.startsWith("--")) {
		deps.out(TELEGRAM_HELP);
		return sub === undefined || sub === "help" || sub === "--help" ? 0 : 2;
	}
	const handle = telegramHandle(target);
	if (!handle) {
		deps.err("Eso no es un canal público de Telegram: escribe @nombre o t.me/nombre.");
		return 2;
	}
	const region = flag(argv, "--cubre");
	const every = flag(argv, "--cada");
	const intervalMin = every === undefined ? undefined : Number(every);
	if (intervalMin !== undefined && !(USER_FEED_INTERVALS_MIN as readonly number[]).includes(intervalMin)) {
		deps.err(`--cada acepta ${USER_FEED_INTERVALS_MIN.join(", ")} minutos.`);
		return 2;
	}
	const body = { url: `@${handle}`, ...(region ? { region } : {}), ...(intervalMin ? { intervalMin } : {}) };

	deps.out(`Probando t.me/s/${handle}…`);
	const port = localPort(argv);
	const local = await localRequest(
		{ port, configDir: deps.configDir, method: "POST", path: "/api/user-feeds", body },
		deps.fetchImpl,
	).catch(() => ({ running: false as const }));
	if (local.running) {
		if (local.status !== 200) {
			deps.err(`No se añadió: ${reasonOf(local.body)}.`);
			return 1;
		}
		const r = local.body as { feed: UserFeed; preview: { items: number } };
		deps.out(`✓ «${r.feed.name}» añadido: ${r.preview.items} publicaciones con texto en su vista pública.`);
		deps.out(`  Vigía (puerto ${port}) ya lo está leyendo; sale en Noticias › «Mis fuentes».`);
		return 0;
	}

	const settings = openSettings(deps.configDir);
	const feeds = new UserFeeds(
		{ list: () => settings.data.userFeeds, save: (next) => settings.setUserFeeds(next) },
		deps.http ?? new SafeHttp(),
	);
	const r = await feeds.add(body);
	if (!r.ok) {
		deps.err(`No se añadió: ${r.reason}`);
		return 1;
	}
	deps.out(`✓ «${r.feed.name}» añadido: ${r.preview.items} publicaciones con texto en su vista pública.`);
	deps.out("  Vigía no está abierto: lo leerá al iniciar (`vigia`); sale en Noticias › «Mis fuentes».");
	return 0;
}
