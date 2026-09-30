import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { dataSaverAsk, now, refreshHealth } from "../lib/data.ts";
import { ago, int, num } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { link } from "../lib/router.ts";
import saverCss from "../styles/datasaver.css?inline";
import { getJson, send } from "./custom/api.ts";

addStyles(saverCss);

/**
 * "Conexión limitada": one server setting that turns off the feeds that download 20 MB a day or more (measured,
 * src/core/bandwidth.ts). Asked once on a person's own Vigía (`ConnectionAsk`), and kept in Personalizar › Mis
 * fuentes and in the guide (`DataSaverSection`). The figures come from the server: measured per feed, summed for
 * the reader's own configuration, and what this machine actually downloaded in the last 24 hours.
 */

interface Estimate {
	mb: number;
	feeds: number;
	unmeasured: number;
}

export interface SaverView {
	on: boolean;
	source: "flag" | "setting" | "unset";
	ask: boolean;
	mode: "local" | "public";
	threshold: number;
	measuredAt: string;
	heavy: {
		id: string;
		name: { es: string; en: string };
		mbPerDay: number | null;
		on: boolean;
		override: boolean | null;
	}[];
	estimate: { current: Estimate; off: Estimate; on: Estimate };
	downloaded: { mb: number; feeds: number; fromMs: number | null; toMs: number };
	unmeasuredOn: string[];
}

const view = signal<SaverView | null>(null);
const failed = signal(false);

async function load(): Promise<void> {
	const v = await getJson<SaverView>("/api/data-saver");
	failed.value = v === null;
	if (v) view.value = v;
}

/** "≈ 1,6 GB" / "≈ 214 MB" / "≈ 3,5 MB": a day's download, rounded as the measurement deserves. */
export function mbText(mb: number): string {
	const l = lang.value;
	// No-break spaces: a figure never wraps away from its unit.
	if (mb >= 1_000) return `${num(mb / 1_024, 1, l)}\u00a0GB`;
	if (mb >= 10) return `${int(mb, l)}\u00a0MB`;
	return `${num(mb, 1, l)}\u00a0MB`;
}

/** Sends the choice; returns an error to show, or null. */
async function choose(on: boolean): Promise<string | null> {
	const r = await send<SaverView>("POST", "/api/data-saver", { on });
	if (!r.ok) return r.error;
	view.value = r.data;
	dataSaverAsk.value = false;
	await refreshHealth().catch(() => {});
	return null;
}

const DISMISSED = "vigia.saverAskDismissed";

function dismissedHere(): boolean {
	try {
		return localStorage.getItem(DISMISSED) === "1";
	} catch {
		return false;
	}
}

function HeavyList({ v, compact = false }: { v: SaverView; compact?: boolean }) {
	const l = lang.value;
	return (
		<ul class={`ds-heavy${compact ? " ds-heavy--compact" : ""}`}>
			{v.heavy.map((h) => (
				<li key={h.id}>
					<span class="ds-heavy__name">{h.name[l]}</span>
					<span class="ds-heavy__mb data">{h.mbPerDay === null ? "—" : mbText(h.mbPerDay)}</span>
					{compact ? null : (
						<span class="ds-heavy__state">
							{h.on ? t("Encendida", "On") : t("Apagada", "Off")}
							{h.override !== null ? (
								<span class="note"> · {t("por tu interruptor", "by your switch")}</span>
							) : null}
						</span>
					)}
				</li>
			))}
		</ul>
	);
}

/**
 * First run on a person's own Vigía: "¿Tu conexión es limitada?", two choices with their measured daily download.
 * Only a browser that may change settings sees it; ✕ ("ahora no") leaves the setting unset and this browser is
 * not asked again (the guide and Personalizar keep the switch).
 */
export function ConnectionAsk() {
	const ref = useRef<HTMLDialogElement>(null);
	const [ready, setReady] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (dismissedHere()) {
			dataSaverAsk.value = false;
			return;
		}
		void (async () => {
			const session = await getJson<{ canChange: boolean }>("/api/session");
			if (!session?.canChange) {
				// This browser cannot answer (no terminal link yet): the question waits for one that can.
				dataSaverAsk.value = false;
				return;
			}
			await load();
			if (view.value?.ask) setReady(true);
			else dataSaverAsk.value = false;
		})();
	}, []);
	useEffect(() => {
		const d = ref.current;
		if (ready && d && !d.open) {
			d.showModal();
			// Start on the sheet itself (screen readers read its title), not on the close button with its ring.
			d.focus();
		}
	}, [ready]);
	const v = view.value;
	if (!ready || !v) return null;
	const pick = async (on: boolean) => {
		setBusy(true);
		const e = await choose(on);
		setBusy(false);
		if (e) return setError(e);
		ref.current?.close();
	};
	const later = () => {
		try {
			localStorage.setItem(DISMISSED, "1");
		} catch {
			// Private window: asked again next time, nothing else changes.
		}
		dataSaverAsk.value = false;
	};
	const n = v.heavy.length;
	return (
		<dialog ref={ref} class="sheet sheet--saver" tabIndex={-1} aria-labelledby="saver-title" onClose={later}>
			<div class="sheet__inner">
				<header class="sheet__head">
					<div>
						<p class="caps sheet__kicker">{t("Antes de empezar", "Before you start")}</p>
						<h2 id="saver-title" class="sheet__title">
							{t("¿Tu conexión es limitada?", "Is your connection limited?")}
						</h2>
						<p class="sheet__sub">
							{t(
								"Vigía descarga cada fuente desde este equipo. Unas pocas descargan mucho (cuadros de TV, el satélite, las cámaras); con datos móviles o un plan pequeño conviene apagarlas.",
								"Vigía downloads every source from this computer. A few download a lot (TV stills, the satellite, the cameras); on mobile data or a small plan it is better to turn them off.",
							)}
						</p>
					</div>
					<button type="button" class="sheet__close" onClick={() => ref.current?.close()}>
						<span aria-hidden="true">✕</span>
						<span class="sr-only">{t("Ahora no", "Not now")}</span>
					</button>
				</header>
				<div class="ds-choices">
					<button type="button" class="ds-choice" disabled={busy} onClick={() => void pick(false)}>
						<span class="ds-choice__name">
							{t("No, es una conexión normal", "No, it's a normal connection")}
						</span>
						<span class="ds-choice__what">{t("Todas las fuentes encendidas", "Every source on")}</span>
						<span class="ds-choice__mb data">≈ {mbText(v.estimate.off.mb)}</span>
						<span class="ds-choice__unit">{t("al día", "a day")}</span>
					</button>
					<button type="button" class="ds-choice" disabled={busy} onClick={() => void pick(true)}>
						<span class="ds-choice__name">{t("Sí, ahorrar datos", "Yes, save data")}</span>
						<span class="ds-choice__what">
							{t(
								`Apaga ${n} fuentes pesadas (${v.threshold} MB al día o más cada una)`,
								`Turns off ${n} heavy sources (${v.threshold} MB a day or more each)`,
							)}
						</span>
						<span class="ds-choice__mb data">≈ {mbText(v.estimate.on.mb)}</span>
						<span class="ds-choice__unit">{t("al día", "a day")}</span>
					</button>
				</div>
				<details class="ds-what">
					<summary>{t(`Qué se apaga (${n})`, `What is turned off (${n})`)}</summary>
					<HeavyList v={v} compact />
				</details>
				{error ? (
					<p class="ds-error" role="alert">
						{error}
					</p>
				) : null}
				<p class="note ds-foot">
					{t(
						"Puedes cambiarlo luego en Personalizar › Mis fuentes o en la guía, y encender cualquier fuente por separado. Cifras medidas por fuente; la guía muestra lo que de verdad descarga este equipo.",
						"You can change it later in Customise › My sources or in the guide, and turn any source on by itself. Figures measured per source; the guide shows what this computer actually downloads.",
					)}
				</p>
			</div>
		</dialog>
	);
}

/** Personalizar › Mis fuentes and the guide: the switch, the figures, the heavy feeds. */
export function DataSaverSection({ variant = "custom" }: { variant?: "custom" | "guide" }) {
	const Sub = variant === "guide" ? "h3" : "h4";
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		void load();
	}, []);
	const v = view.value;
	const l = lang.value;
	if (!v)
		return (
			<section class="ds" aria-busy={!failed.value}>
				<p class="note">
					{failed.value
						? t("Este Vigía no informa de su descarga.", "This Vigía does not report its download.")
						: t("Cargando…", "Loading…")}
				</p>
			</section>
		);
	const byFlag = v.source === "flag";
	const toggle = async () => {
		setBusy(true);
		setError(await choose(!v.on));
		setBusy(false);
	};
	const d = v.downloaded;
	const windowMs = d.fromMs === null ? 0 : d.toMs - d.fromMs;
	const firmsHeavy = v.heavy.some((h) => h.id === "firms-fires");
	return (
		<section class="ds" aria-labelledby="ds-h">
			<div class="ds-row">
				<div>
					{variant === "guide" ? (
						<h2 id="ds-h" class="guide__step-title">
							<span class="guide__num">+</span>
							{t("Conexión limitada", "Limited connection")}
						</h2>
					) : (
						<h3 id="ds-h" class="custom-h">
							{t("Conexión limitada", "Limited connection")}
						</h3>
					)}
					<p class="note">
						{t(
							`Apaga las fuentes que descargan ${v.threshold} MB al día o más. Tus interruptores de cada fuente siguen mandando.`,
							`Turns off the sources that download ${v.threshold} MB a day or more. Your switch for each source still wins.`,
						)}
					</p>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={v.on}
					aria-labelledby="ds-h"
					class={`ds-switch${v.on ? " is-on" : ""}`}
					disabled={busy || byFlag || v.mode === "public"}
					onClick={() => void toggle()}
				/>
			</div>
			{byFlag ? (
				<p class="note">
					{v.on
						? t("Fijada al iniciar Vigía", "Set when Vigía was started")
						: t("Fijada apagada al iniciar Vigía", "Set off when Vigía was started")}{" "}
					(<code class="mono">--data-saver</code> {t("o", "or")} <code class="mono">VIGIA_DATA_SAVER</code>).
				</p>
			) : v.mode === "public" ? (
				<p class="note">
					{t(
						"Espejo público: lo decide quien lo opera (--data-saver).",
						"Public mirror: its operator decides (--data-saver).",
					)}
				</p>
			) : null}
			{error ? (
				<p class="ds-error" role="alert">
					{error}
				</p>
			) : null}
			<dl class="ds-figs">
				<div class="ds-fig">
					<dt>{t("Estimado, tu configuración", "Estimated, your setup")}</dt>
					<dd class="data">≈ {mbText(v.estimate.current.mb)}</dd>
					<dd class="ds-fig__sub">
						{t(`al día, ${v.estimate.current.feeds} fuentes`, `a day, ${v.estimate.current.feeds} sources`)}
					</dd>
				</div>
				<div class="ds-fig">
					<dt>{t("Todo encendido", "Everything on")}</dt>
					<dd class="data">≈ {mbText(v.estimate.off.mb)}</dd>
					<dd class="ds-fig__sub">{t("al día", "a day")}</dd>
				</div>
				<div class="ds-fig">
					<dt>{t("Con conexión limitada", "With limited connection")}</dt>
					<dd class="data">≈ {mbText(v.estimate.on.mb)}</dd>
					<dd class="ds-fig__sub">{t("al día", "a day")}</dd>
				</div>
				<div class="ds-fig">
					<dt>{t("Medido en este equipo", "Measured on this computer")}</dt>
					<dd class="data">{d.fromMs === null ? "—" : mbText(d.mb)}</dd>
					<dd class="ds-fig__sub">
						{d.fromMs === null
							? t("aún sin lecturas medidas", "no metered reads yet")
							: windowMs >= 23 * 3_600_000
								? t("en las últimas 24 h", "in the last 24 h")
								: t(`desde ${ago(now.value - d.fromMs, l)}`, `since ${ago(now.value - d.fromMs, l)}`)}
					</dd>
				</div>
			</dl>
			<p class="note">
				{t(
					`Estimado: la medición de cada fuente (${v.measuredAt}) por sus lecturas al día, sumada para las fuentes que corren con tus ajustes y claves; sin contar tus fuentes añadidas${v.estimate.current.unmeasured ? ` ni ${v.estimate.current.unmeasured} fuentes sin medición` : ""}. Medido: cabeceras y cuerpos tal como llegaron, sin la capa TLS.`,
					`Estimated: each source's measurement (${v.measuredAt}) times its reads a day, summed over the sources that run with your settings and keys; not counting sources you added${v.estimate.current.unmeasured ? ` or ${v.estimate.current.unmeasured} sources without a measurement` : ""}. Measured: headers and bodies as they arrived, without the TLS layer.`,
				)}
			</p>
			{/* One level under the section's heading: h2 in the guide, h3 in Personalizar (axe heading-order). */}
			<Sub class="caps ds-sub">{t("Fuentes pesadas", "Heavy sources")}</Sub>
			<HeavyList v={v} />
			{firmsHeavy ? (
				<p class="note">
					{t(
						"Incendios deja de ser pesada con la clave gratuita de NASA FIRMS (consulta solo Venezuela):",
						"Fires stops being heavy with the free NASA FIRMS key (it asks for Venezuela only):",
					)}{" "}
					{variant === "guide" ? (
						t("paso 2 de esta guía.", "step 2 of this guide.")
					) : (
						<>
							<a class="link" {...link("guide")}>
								{t("guía, claves gratuitas", "guide, free keys")}
							</a>
							.
						</>
					)}
				</p>
			) : null}
		</section>
	);
}

/** The guide's item: TV stills need ffmpeg (optional), detected live on the computer running Vigía. */
interface FfmpegInfo {
	found: boolean;
	version: string | null;
	disabled: boolean;
	fromEnv: boolean;
}

const INSTALL: { os: string; cmd: string; note?: { es: string; en: string } }[] = [
	{ os: "Debian, Ubuntu, Mint", cmd: "sudo apt install ffmpeg" },
	{
		os: "Fedora",
		cmd: "sudo dnf install ffmpeg --allowerasing",
		note: {
			es: "con RPM Fusion activado: el paquete ffmpeg-free de Fedora no trae el decodificador H.264",
			en: "with RPM Fusion enabled: Fedora's ffmpeg-free package lacks the H.264 decoder",
		},
	},
	{ os: "Arch, Manjaro", cmd: "sudo pacman -S ffmpeg" },
	{ os: "macOS (Homebrew)", cmd: "brew install ffmpeg" },
	{
		os: "Windows",
		cmd: "winget install --id Gyan.FFmpeg -e",
		note: {
			es: "después cierra y abre Vigía: Windows solo da el nuevo PATH a programas nuevos",
			en: "then close and reopen Vigía: Windows gives the new PATH only to new programs",
		},
	},
	{ os: "Docker", cmd: "", note: { es: "ya viene en la imagen", en: "already in the image" } },
];

export function FfmpegSection() {
	const [info, setInfo] = useState<FfmpegInfo | null>(null);
	const [checking, setChecking] = useState(false);
	const check = async (again: boolean) => {
		setChecking(true);
		setInfo(await getJson<FfmpegInfo>(`/api/ffmpeg${again ? "?otra-vez=1" : ""}`));
		setChecking(false);
	};
	useEffect(() => {
		void check(false);
	}, []);
	const l = lang.value;
	const stills = view.value?.heavy.find((h) => h.id === "tv-stills");
	return (
		<section class="ds ds--ffmpeg" aria-labelledby="ff-h">
			<h2 id="ff-h" class="guide__step-title">
				<span class="guide__num">+</span>
				{t("Cuadros de TV: necesita ffmpeg (opcional)", "TV stills: needs ffmpeg (optional)")}
			</h2>
			<p class="note">
				{t(
					"Para mostrar un cuadro reciente de cada canal en vivo, Vigía decodifica una sola imagen de su transmisión con ffmpeg, un programa libre. Sin él, las tarjetas muestran el logo del canal y lo dicen; nada más cambia.",
					"To show a recent frame of each live channel, Vigía decodes a single picture of its stream with ffmpeg, a free program. Without it, the cards show the channel's logo and say so; nothing else changes.",
				)}
				{stills?.mbPerDay
					? t(
							` Los cuadros descargan ≈ ${mbText(stills.mbPerDay)} al día: con conexión limitada se apagan.`,
							` The stills download ≈ ${mbText(stills.mbPerDay)} a day: limited connection turns them off.`,
						)
					: ""}
			</p>
			<p class="ds-ffmpeg__state" role="status">
				{info === null ? (
					<span class="note">{checking ? t("Buscando ffmpeg…", "Looking for ffmpeg…") : "—"}</span>
				) : info.found ? (
					<>
						<span class="ds-mark ds-mark--ok" aria-hidden="true" />
						{t(
							`Encontrado en este equipo: ffmpeg ${info.version ?? ""}.`,
							`Found on this computer: ffmpeg ${info.version ?? ""}.`,
						)}
					</>
				) : info.disabled ? (
					<>
						<span class="ds-mark" aria-hidden="true" />
						{t("Apagado a propósito (VIGIA_FFMPEG=0).", "Turned off on purpose (VIGIA_FFMPEG=0).")}
					</>
				) : (
					<>
						<span class="ds-mark" aria-hidden="true" />
						{info.fromEnv
							? t(
									"No se encontró el ffmpeg que indica VIGIA_FFMPEG.",
									"The ffmpeg VIGIA_FFMPEG names was not found.",
								)
							: t("No está instalado en este equipo.", "Not installed on this computer.")}
					</>
				)}{" "}
				<button type="button" class="link-button" disabled={checking} onClick={() => void check(true)}>
					{t("Comprobar otra vez", "Check again")}
				</button>
			</p>
			{info?.found ? null : (
				<table class="ds-install">
					<caption class="sr-only">{t("Cómo instalar ffmpeg", "How to install ffmpeg")}</caption>
					<tbody>
						{INSTALL.map((row) => (
							<tr key={row.os}>
								<th scope="row">{row.os}</th>
								<td>
									{row.cmd ? <code class="mono">{row.cmd}</code> : null}
									{row.note ? <span class="note"> {row.note[l]}</span> : null}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</section>
	);
}
