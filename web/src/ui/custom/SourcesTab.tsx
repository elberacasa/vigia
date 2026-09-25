import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import {
	healthById,
	meta,
	now,
	type PackedMeta,
	refreshHealth,
	refreshPanels,
	unpackMeta,
} from "../../lib/data.ts";
import { ago } from "../../lib/format.ts";
import { lang, t } from "../../lib/i18n.ts";
import { stateName } from "../../lib/states.ts";
import { STATES } from "../../map/geometry.gen.ts";
import { StateBadge } from "../Source.tsx";
import { getJson, send } from "./api.ts";
import { newsSource } from "./NewsMine.tsx";

interface UserFeed {
	id: string;
	url: string;
	name: string;
	region: string;
	intervalMin: 15 | 30 | 60 | 180;
	addedAt: number;
}

const LIMIT = 30;
const INTERVALS = [15, 30, 60, 180] as const;
const feeds = signal<UserFeed[] | null>(null);

async function load(): Promise<void> {
	const data = await getJson<{ feeds: UserFeed[] }>("/api/user-feeds");
	feeds.value = data?.feeds ?? [];
}

/** After a change: the list, the status page's names, health, and the "Mis fuentes" news view. */
async function refreshAll(): Promise<void> {
	await load();
	const m = await getJson<PackedMeta>("/api/meta");
	if (m) meta.value = unpackMeta(m);
	await Promise.all([refreshHealth().catch(() => {}), refreshPanels(["user-news"]).catch(() => {})]);
}

function regionLabel(region: string): string {
	if (region === "national") return t("Venezuela (nacional)", "Venezuela (national)");
	if (region === "international") return t("Internacional", "International");
	return stateName(region);
}

/** The channel of a Telegram source (stored as its preview address https://t.me/s/<handle>). */
function telegramHandle(url: string): string | null {
	return /^https:\/\/t\.me\/s\/([A-Za-z0-9_]{4,32})\/?$/.exec(url)?.[1] ?? null;
}

function host(url: string): string {
	const handle = telegramHandle(url);
	if (handle) return `@${handle}`;
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

function RegionSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
	return (
		<select
			id={id}
			class="input"
			value={value}
			onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
		>
			<option value="national">{t("Venezuela (nacional)", "Venezuela (national)")}</option>
			<option value="international">{t("Internacional", "International")}</option>
			<optgroup label={t("Un estado", "A state")}>
				{[...STATES]
					.sort((a, b) => a.name.localeCompare(b.name, "es"))
					.map((s) => (
						<option key={s.iso} value={s.iso}>
							{s.name}
						</option>
					))}
			</optgroup>
		</select>
	);
}

function IntervalSelect({
	id,
	value,
	onChange,
}: {
	id: string;
	value: number;
	onChange: (v: number) => void;
}) {
	return (
		<select
			id={id}
			class="input"
			value={String(value)}
			onChange={(e) => onChange(Number((e.target as HTMLSelectElement).value))}
		>
			{INTERVALS.map((m) => (
				<option key={m} value={String(m)}>
					{m < 60 ? t(`cada ${m} min`, `every ${m} min`) : t(`cada ${m / 60} h`, `every ${m / 60} h`)}
				</option>
			))}
		</select>
	);
}

function FeedRow({ f }: { f: UserFeed }) {
	const l = lang.value;
	const h = healthById.value.get(f.id);
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(f.name);
	const [region, setRegion] = useState(f.region);
	const [every, setEvery] = useState<number>(f.intervalMin);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const save = async (e: Event) => {
		e.preventDefault();
		setBusy(true);
		const r = await send<{ feed: UserFeed }>("PATCH", `/api/user-feeds/${f.id}`, {
			name,
			region,
			intervalMin: every,
		});
		setBusy(false);
		if (!r.ok) return setError(r.error);
		setError("");
		setEditing(false);
		await refreshAll();
	};
	const remove = async () => {
		if (!confirm(t(`¿Dejar de seguir «${f.name}»?`, `Stop following “${f.name}”?`))) return;
		setBusy(true);
		const r = await send("DELETE", `/api/user-feeds/${f.id}`);
		setBusy(false);
		if (!r.ok) return setError(r.error);
		await refreshAll();
	};

	return (
		<li class="feed-row">
			<div class="feed-row__main">
				<p class="feed-row__name">
					<strong>{f.name}</strong> <span class="tag tag--mine">{t("añadida por ti", "added by you")}</span>
				</p>
				<p class="feed-row__meta note">
					<a class="link" href={f.url} target="_blank" rel="noopener noreferrer">
						{host(f.url)}
					</a>
					{telegramHandle(f.url) ? " · Telegram" : ""} · {regionLabel(f.region)} ·{" "}
					{f.intervalMin < 60
						? t(`cada ${f.intervalMin} min`, `every ${f.intervalMin} min`)
						: t(`cada ${f.intervalMin / 60} h`, `every ${f.intervalMin / 60} h`)}
				</p>
				<p class="feed-row__health">
					{h ? (
						<StateBadge state={h.state} />
					) : (
						<span class="badge badge--pending">{t("Cargando", "Loading")}</span>
					)}{" "}
					<span class="note data">
						{h?.newestObservedAt
							? t(
									`último titular ${ago(now.value - h.newestObservedAt, l)}`,
									`newest headline ${ago(now.value - h.newestObservedAt, l)}`,
								)
							: h?.lastSuccessAt
								? t(
										`leída ${ago(now.value - h.lastSuccessAt, l)}`,
										`read ${ago(now.value - h.lastSuccessAt, l)}`,
									)
								: t("aún sin leer", "not read yet")}
					</span>
				</p>
				{h?.lastError ? <p class="note feed-row__error">{h.lastError}</p> : null}
				{editing ? (
					<form class="feed-edit" onSubmit={save}>
						<label for={`fn-${f.id}`}>{t("Nombre", "Name")}</label>
						<input
							id={`fn-${f.id}`}
							class="input"
							value={name}
							maxLength={80}
							onInput={(e) => setName((e.target as HTMLInputElement).value)}
						/>
						<label for={`fr-${f.id}`}>{t("Cubre", "Covers")}</label>
						<RegionSelect id={`fr-${f.id}`} value={region} onChange={setRegion} />
						<label for={`fi-${f.id}`}>{t("Leer", "Read")}</label>
						<IntervalSelect id={`fi-${f.id}`} value={every} onChange={setEvery} />
						<div class="custom-actions">
							<button type="submit" class="button button--small button--primary" disabled={busy}>
								{t("Guardar", "Save")}
							</button>
							<button type="button" class="button button--small" onClick={() => setEditing(false)}>
								{t("Cancelar", "Cancel")}
							</button>
						</div>
					</form>
				) : null}
				{error ? (
					<p class="custom-msg custom-msg--error" role="alert">
						{error}
					</p>
				) : null}
			</div>
			{editing ? null : (
				<div class="feed-row__actions">
					<button type="button" class="button button--small" onClick={() => setEditing(true)}>
						{t("Editar", "Edit")}
					</button>
					<button
						type="button"
						class="button button--small row-menu__danger"
						disabled={busy}
						onClick={remove}
					>
						{t("Quitar", "Remove")}
					</button>
				</div>
			)}
		</li>
	);
}

export function SourcesTab() {
	const l = lang.value;
	const [url, setUrl] = useState("");
	const [name, setName] = useState("");
	const [region, setRegion] = useState("national");
	const [every, setEvery] = useState<number>(30);
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
	const [channel, setChannel] = useState("");
	const [channelBusy, setChannelBusy] = useState(false);
	const [channelResult, setChannelResult] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
	useEffect(() => {
		void load();
	}, []);
	const list = feeds.value;

	const add = async (e: Event) => {
		e.preventDefault();
		setBusy(true);
		setResult(null);
		const r = await send<{ feed: UserFeed; preview: { items: number; newestAt: number | null } }>(
			"POST",
			"/api/user-feeds",
			{
				url: url.trim(),
				...(name.trim() ? { name: name.trim() } : {}),
				region,
				intervalMin: every,
			},
		);
		setBusy(false);
		if (!r.ok) {
			setResult({ tone: "error", text: r.error });
			return;
		}
		const p = r.data.preview;
		setResult({
			tone: "ok",
			text:
				t(
					`«${r.data.feed.name}» añadida: ${p.items} titulares en el feed`,
					`“${r.data.feed.name}” added: ${p.items} headlines in the feed`,
				) +
				(p.newestAt
					? t(
							`, el más reciente de ${ago(now.value - p.newestAt, l)}.`,
							`, the newest ${ago(now.value - p.newestAt, l)}.`,
						)
					: t(", sin fechas.", ", undated.")),
		});
		setUrl("");
		setName("");
		await refreshAll();
	};

	// A public Telegram channel: the server turns "@nombre" or "t.me/nombre" into its preview address and checks it.
	const addChannel = async (e: Event) => {
		e.preventDefault();
		setChannelBusy(true);
		setChannelResult(null);
		const r = await send<{ feed: UserFeed; preview: { items: number; newestAt: number | null } }>(
			"POST",
			"/api/user-feeds",
			{ url: channel.trim() },
		);
		setChannelBusy(false);
		if (!r.ok) {
			setChannelResult({ tone: "error", text: r.error });
			return;
		}
		const p = r.data.preview;
		setChannelResult({
			tone: "ok",
			text:
				t(
					`«${r.data.feed.name}» añadido: ${p.items} publicaciones con texto en su vista pública`,
					`“${r.data.feed.name}” added: ${p.items} posts with text in its public preview`,
				) +
				(p.newestAt
					? t(
							`, la más reciente de ${ago(now.value - p.newestAt, l)}.`,
							`, the newest ${ago(now.value - p.newestAt, l)}.`,
						)
					: "."),
		});
		setChannel("");
		await refreshAll();
	};

	return (
		<div class="custom-tab">
			<section aria-labelledby="add-h">
				<h3 id="add-h" class="custom-h">
					{t("Añadir un feed RSS o Atom", "Add an RSS or Atom feed")}
				</h3>
				<p class="note custom-lead">
					{t(
						"Un medio local, un blog, una ONG: si publica un feed, Vigía lo lee desde este equipo, con la misma pausa cortés que al resto. Sus titulares salen en Noticias › «Mis fuentes», marcados «añadida por ti», y no cuentan en los totales, el mapa ni los incidentes de Vigía.",
						"A local outlet, a blog, an NGO: if it publishes a feed, Vigía reads it from this machine, as politely paced as the rest. Its headlines appear under News › “My sources”, marked “added by you”, and never count in Vigía's totals, map or incidents.",
					)}
				</p>
				<form class="feed-form" onSubmit={add}>
					<label for="feed-url">{t("Dirección del feed", "Feed address")}</label>
					<input
						id="feed-url"
						class="input"
						type="url"
						inputMode="url"
						required
						placeholder="https://ejemplo.com/feed/"
						value={url}
						maxLength={2048}
						onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
					/>
					<label for="feed-name">
						{t("Nombre", "Name")}{" "}
						<span class="note">{t("(opcional: se toma del feed)", "(optional: taken from the feed)")}</span>
					</label>
					<input
						id="feed-name"
						class="input"
						value={name}
						maxLength={80}
						onInput={(e) => setName((e.target as HTMLInputElement).value)}
					/>
					<div class="feed-form__row">
						<div>
							<label for="feed-region">{t("Cubre", "Covers")}</label>
							<RegionSelect id="feed-region" value={region} onChange={setRegion} />
						</div>
						<div>
							<label for="feed-interval">{t("Leer", "Read")}</label>
							<IntervalSelect id="feed-interval" value={every} onChange={setEvery} />
						</div>
					</div>
					<button
						type="submit"
						class="button button--primary"
						disabled={busy || !url.trim() || (list?.length ?? 0) >= LIMIT}
					>
						{busy ? t("Probando el feed…", "Testing the feed…") : t("Probar y añadir", "Test and add")}
					</button>
				</form>
				{result ? (
					<p
						class={`custom-msg custom-msg--${result.tone}`}
						role={result.tone === "error" ? "alert" : "status"}
					>
						{result.text}{" "}
						{result.tone === "ok" ? (
							<button type="button" class="link-button" onClick={() => (newsSource.value = "mine")}>
								{t("Verlas en Noticias", "See them in News")}
							</button>
						) : null}
					</p>
				) : null}
				<p class="note">
					{t(
						"Por seguridad solo se aceptan direcciones http(s) públicas: nada de la red local, y cada redirección se revisa.",
						"For safety only public http(s) addresses are accepted: nothing on the local network, and every redirect is checked.",
					)}
				</p>
			</section>
			<section aria-labelledby="tg-h">
				<h3 id="tg-h" class="custom-h">
					{t("Añadir un canal de Telegram", "Add a Telegram channel")}
				</h3>
				<p class="note custom-lead">
					{t(
						"Un canal público (de un medio, una institución, una ONG): Vigía lee su vista pública en t.me/s, una página cada 30 minutos, y muestra el inicio de cada publicación con su enlace. Como tus feeds, queda en este equipo y sale en «Mis fuentes»; con «Editar» cambias el estado que cubre o el ritmo.",
						"A public channel (an outlet, an institution, an NGO): Vigía reads its public preview at t.me/s, one page every 30 minutes, and shows the start of each post with its link. Like your feeds, it stays on this machine and appears under “My sources”; “Edit” changes the state it covers or the pace.",
					)}
				</p>
				<form class="feed-form" onSubmit={addChannel}>
					<label for="tg-channel">{t("Canal de Telegram", "Telegram channel")}</label>
					<input
						id="tg-channel"
						class="input"
						required
						autoComplete="off"
						autoCapitalize="off"
						spellcheck={false}
						placeholder="@canal o t.me/canal"
						value={channel}
						maxLength={200}
						pattern="\s*(@|(https?://)?(www\.)?(t\.me|telegram\.me)/)?(s/)?[A-Za-z][A-Za-z0-9_]{3,31}(/\d+)?/?\s*"
						title={t("@nombre o t.me/nombre", "@name or t.me/name")}
						onInput={(e) => setChannel((e.target as HTMLInputElement).value)}
					/>
					<button
						type="submit"
						class="button button--primary"
						disabled={channelBusy || !channel.trim() || (list?.length ?? 0) >= LIMIT}
					>
						{channelBusy
							? t("Probando el canal…", "Testing the channel…")
							: t("Probar y añadir", "Test and add")}
					</button>
				</form>
				{channelResult ? (
					<p
						class={`custom-msg custom-msg--${channelResult.tone}`}
						role={channelResult.tone === "error" ? "alert" : "status"}
					>
						{channelResult.text}{" "}
						{channelResult.tone === "ok" ? (
							<button type="button" class="link-button" onClick={() => (newsSource.value = "mine")}>
								{t("Verlas en Noticias", "See them in News")}
							</button>
						) : null}
					</p>
				) : null}
				<p class="note">
					{t(
						"Solo canales públicos: los enlaces de invitación (t.me/+…) son privados y no se aceptan. También desde la terminal: ",
						"Public channels only: invite links (t.me/+…) are private and refused. Also from the terminal: ",
					)}
					<code class="data">vigia telegram add @canal</code>
				</p>
			</section>
			<section aria-labelledby="mine-h">
				<h3 id="mine-h" class="custom-h">
					{t("Tus fuentes", "Your sources")}{" "}
					<span class="data note">
						{list?.length ?? 0}/{LIMIT}
					</span>
				</h3>
				{list === null ? (
					<p class="note">{t("Cargando…", "Loading…")}</p>
				) : list.length ? (
					<ul class="feed-list">
						{list.map((f) => (
							<FeedRow key={f.id} f={f} />
						))}
					</ul>
				) : (
					<p class="empty">{t("Aún no añadiste ninguna.", "You have not added any yet.")}</p>
				)}
				<p class="note">
					{t(
						"Quitar una fuente deja de leerla; los titulares ya guardados quedan en el archivo local de este equipo.",
						"Removing a source stops reading it; headlines already stored stay in this machine's local archive.",
					)}
				</p>
			</section>
		</div>
	);
}
