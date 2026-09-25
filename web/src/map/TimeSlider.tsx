import { useEffect, useRef, useState } from "preact/hooks";
import { healthById, now } from "../lib/data.ts";
import { ago, stamp } from "../lib/format.ts";
import { isLive } from "../lib/fresh.ts";
import { lang, t } from "../lib/i18n.ts";
import {
	type ConnectivityHistory,
	type HistoryStep,
	history,
	historyState,
	historyStep,
	indexAt,
	loadHistory,
	RANGES,
	stepFor,
	stepLabel,
} from "./history.ts";
import { ignoredTime, setViewTime, viewTime } from "./view.ts";

/** Worst level in a step across states, for the bar colour. */
function tone(c: ConnectivityHistory["counts"][number]): "severe" | "drop" | "ok" | "nodata" {
	if (c.severe) return "severe";
	if (c.drop) return "drop";
	if (c.normal) return "ok";
	return "nodata";
}

/**
 * History strip under the map (Internet layer): one bar per step, its height the number of states with a drop, its
 * colour the worst level. Dragging (or arrow keys) re-shades the map from stored observations at that time; nothing is
 * interpolated. The right end is live.
 */
export function TimeSlider() {
	const l = lang.value;
	const h = history.value;
	const step = historyStep.value;
	const vt = viewTime.value;
	const [playing, setPlaying] = useState(false);
	const playRef = useRef<ReturnType<typeof setInterval> | null>(null);

	// A ?t= link from last week opens on the range that contains it.
	useEffect(() => {
		if (vt !== null) historyStep.value = stepFor(vt, now.value);
	}, []);

	// Fetched when the strip is first shown, and refreshed at most every 5 minutes while it stays open.
	const bucket = Math.floor(now.value / 300_000);
	useEffect(() => {
		void loadHistory(step, now.value);
	}, [step, bucket]);

	useEffect(
		() => () => {
			if (playRef.current) clearInterval(playRef.current);
		},
		[],
	);

	// A ?t= outside the stored history (too old, or in the future) falls back to live instead of lingering in the URL.
	useEffect(() => {
		if (h && h.step === step && vt !== null && indexAt(h, vt) === -1) {
			ignoredTime.value = { at: vt, reason: "range" };
			setViewTime(null);
		}
	}, [h, step, vt]);

	const n = h?.times.length ?? 0;
	const index = h && vt !== null ? indexAt(h, vt) : -1;
	/** Slider position: 0..n-1 are past steps, n is live. */
	const pos = vt === null || index === -1 ? n : index;
	const stop = () => {
		if (playRef.current) clearInterval(playRef.current);
		playRef.current = null;
		setPlaying(false);
	};
	const goTo = (p: number) => {
		if (!h) return;
		if (p >= n) setViewTime(null);
		else setViewTime(h.times[Math.max(0, p)] ?? null);
	};
	const play = () => {
		if (!h || !n) return;
		if (playing) {
			stop();
			return;
		}
		let p =
			pos >= n
				? Math.max(
						0,
						h.counts.findIndex((c) => c.noData < Object.keys(h.states).length),
					)
				: pos;
		goTo(p);
		setPlaying(true);
		playRef.current = setInterval(() => {
			p += 1;
			goTo(p);
			if (p >= n) stop();
		}, 400);
	};

	const max = Math.max(1, ...(h?.counts ?? []).map((c) => c.drop + c.severe));
	const ioda = healthById.value.get("ioda-states");
	const feedLive = ioda === undefined || isLive(ioda.state);
	const lastAt = ioda ? (ioda.newestObservedAt ?? ioda.lastSuccessAt) : null;
	const past = vt !== null && index !== -1 && h;
	return (
		<div class={`timeline-strip${past ? " is-past" : ""}`}>
			<div class="timeline-strip__head">
				<fieldset class="range-chips">
					<legend class="sr-only">{t("Periodo del historial", "History range")}</legend>
					{(Object.keys(RANGES) as HistoryStep[]).map((s) => (
						<button
							type="button"
							key={s}
							class="range-chip"
							aria-pressed={step === s}
							onClick={() => {
								stop();
								setViewTime(null);
								historyStep.value = s;
							}}
						>
							{RANGES[s][l]}
						</button>
					))}
				</fieldset>
				<button
					type="button"
					class="timeline-strip__play"
					onClick={play}
					disabled={!n}
					aria-label={playing ? t("Pausar", "Pause") : t("Reproducir el historial", "Play the history")}
				>
					<span aria-hidden="true">{playing ? "❚❚" : "▶"}</span>
				</button>
				<p class="timeline-strip__status" aria-live="polite">
					{past ? (
						<span class="timeline-strip__past">
							{t("Viendo", "Viewing")}: {stepLabel(h.times[index] as number, h.stepMs, l)} ·{" "}
							{t("datos de ese momento", "data from that time")}
						</span>
					) : historyState.value === "busy" ? (
						<span class="note">
							{t("Historial ocupado", "History busy")} ·{" "}
							<button type="button" class="link" onClick={() => void loadHistory(step, now.value, true)}>
								{t("reintentar", "retry")}
							</button>
						</span>
					) : historyState.value === "error" ? (
						<span class="note">{t("Historial no disponible ahora", "History unavailable now")}</span>
					) : (
						<span class="note">{t("Arrastre para ver horas anteriores", "Drag to see earlier hours")}</span>
					)}
				</p>
				<button
					type="button"
					class={`live-button${past ? "" : feedLive ? " is-live" : " is-late"}`}
					aria-pressed={!past}
					title={
						feedLive
							? undefined
							: t(
									"IODA no ha entregado datos dentro de su plazo: la barra de la derecha es el último dato, no el presente",
									"IODA has not delivered data inside its budget: the right-hand bar is the latest data, not the present",
								)
					}
					onClick={() => {
						stop();
						setViewTime(null);
					}}
				>
					<span class="live-button__dot" aria-hidden="true" />
					{/* "EN VIVO" only while the feed behind the map is inside its budget (review 3, H5). */}
					{feedLive
						? t("EN VIVO", "LIVE")
						: lastAt
							? t(
									`Último dato · ${ago(now.value - lastAt, l)}`,
									`Latest data · ${ago(now.value - lastAt, l)}`,
								)
							: t("Sin datos", "No data")}
				</button>
			</div>
			<div class="timeline-strip__track">
				<svg
					class="timeline-strip__bars"
					viewBox={`0 0 ${Math.max(1, n + 1)} 28`}
					preserveAspectRatio="none"
					aria-hidden="true"
				>
					{(h?.counts ?? []).map((c, i) => {
						const affected = c.drop + c.severe;
						const kind = tone(c);
						const bh = kind === "nodata" ? 3 : affected ? 6 + (22 * affected) / max : 2;
						return (
							<rect
								key={h?.times[i]}
								x={i + 0.12}
								y={28 - bh}
								width={0.76}
								height={bh}
								class={`tl-bar tl-bar--${kind}${i === pos ? " is-current" : ""}`}
							/>
						);
					})}
					<rect
						x={n + 0.12}
						y={0}
						width={0.76}
						height={28}
						class={`tl-bar tl-bar--live${pos === n ? " is-current" : ""}`}
					/>
				</svg>
				{n ? (
					<span
						class="timeline-strip__cursor"
						style={{ left: `${(((pos + 0.5) / (n + 1)) * 100).toFixed(3)}%` }}
						aria-hidden="true"
					/>
				) : null}
				<input
					type="range"
					class="timeline-strip__range"
					min={0}
					max={n}
					step={1}
					value={pos}
					disabled={!n}
					aria-label={t("Momento que muestra el mapa", "Time shown on the map")}
					aria-valuetext={
						past
							? `${t("Viendo", "Viewing")} ${stepLabel(h.times[index] as number, h.stepMs, l)}`
							: t("En vivo", "Live")
					}
					onInput={(e) => {
						stop();
						goTo(Number((e.target as HTMLInputElement).value));
					}}
				/>
			</div>
			<div class="timeline-strip__axis data">
				<span aria-hidden="true">{h?.times[0] !== undefined ? stamp(h.times[0], l) : ""}</span>
				{h ? (
					<a href={h.sourceUrl} target="_blank" rel="noopener noreferrer" title={h.rule[l]}>
						{t("Datos: IODA, Georgia Tech", "Data: IODA, Georgia Tech")}
					</a>
				) : null}
				<span aria-hidden="true">{t("ahora", "now")}</span>
			</div>
		</div>
	);
}
