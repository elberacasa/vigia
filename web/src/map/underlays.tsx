import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { panels } from "../lib/data.ts";
import { stamp } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import type { Bounds, NightlightsView, SatelliteView } from "../panels/Imagery.tsx";
import { project } from "./project.ts";

/* The imagery layers the map draws in the first load (the Satellite and Night-lights panels load on demand). */

/** Which frame of the loop is shown on the map (null: newest). */
export const satelliteFrame = signal<number | null>(null);

/** A raster in the map's projection: stretched to its lon/lat bounds (the images are plain lon/lat, north up). */
export function RasterLayer({ url, bounds, blend }: { url: string; bounds: Bounds; blend?: boolean }) {
	const [x0, y0] = project(bounds.west, bounds.north);
	const [x1, y1] = project(bounds.east, bounds.south);
	return (
		<image
			href={url}
			x={x0}
			y={y0}
			width={x1 - x0}
			height={y1 - y0}
			preserveAspectRatio="none"
			class={blend ? "raster raster--screen" : "raster"}
		/>
	);
}

export function SatelliteUnderlay() {
	const view = panels.value.satellite as SatelliteView | undefined;
	if (!view?.bounds || !view.frames.length) return null;
	const i = satelliteFrame.value ?? view.frames.length - 1;
	const frame = view.frames[Math.min(i, view.frames.length - 1)];
	return frame ? <RasterLayer url={frame.url} bounds={view.bounds} /> : null;
}

export function NightUnderlay() {
	const view = panels.value.nightlights as NightlightsView | undefined;
	return view?.image ? <RasterLayer url={view.image.url} bounds={view.image.bounds} blend={true} /> : null;
}

/** Loop controls: the loop only moves when the person presses play (motion carries data, never decoration). */
export function SatelliteControls() {
	const view = panels.value.satellite as SatelliteView | undefined;
	const [playing, setPlaying] = useState(false);
	const l = lang.value;
	const n = view?.frames.length ?? 0;
	useEffect(() => {
		if (!playing || n < 2) return;
		// Preload so the loop does not flash.
		for (const f of view?.frames ?? []) {
			const img = new Image();
			img.src = f.url;
		}
		const id = setInterval(() => {
			const cur = satelliteFrame.value ?? n - 1;
			satelliteFrame.value = (cur + 1) % n;
		}, 450);
		return () => clearInterval(id);
	}, [playing, n, view?.frames]);
	if (!view?.frames.length) return null;
	const i = satelliteFrame.value ?? n - 1;
	const frame = view.frames[Math.min(i, n - 1)];
	return (
		<div class="loop">
			<button type="button" class="chip" onClick={() => setPlaying(!playing)} aria-pressed={playing}>
				{playing ? "❚❚" : "▶"}{" "}
				<span class="sr-only">{playing ? t("Pausar", "Pause") : t("Reproducir", "Play")}</span>
			</button>
			<input
				type="range"
				min={0}
				max={n - 1}
				value={i}
				aria-label={t("Imagen del satélite", "Satellite frame")}
				onInput={(e) => {
					setPlaying(false);
					satelliteFrame.value = Number((e.target as HTMLInputElement).value);
				}}
			/>
			<span class="data loop__time">{frame ? stamp(frame.observedAt, l) : ""}</span>
		</div>
	);
}
