import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { panels } from "../lib/data.ts";
import { lang, t } from "../lib/i18n.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import livetvCss from "../styles/livetv.css?inline";
import { Panel } from "../ui/Panel.tsx";

addStyles(livetvCss);

/* Mirrors src/panels/livetv.ts. */

type CardState = "live" | "upcoming" | "off" | "unknown" | "stale" | "unmeasured";
export interface LiveCard {
	id: string;
	kind: "tv" | "radio";
	name: string;
	where: string | null;
	labelEs: string;
	labelEn: string;
	ownership: string;
	lang: string;
	homepage: string;
	verified: string;
	state: CardState;
	detail: string | null;
	checkedAt: number | null;
	sourceUrl: string;
	title: string | null;
	startedAt: number | null;
	playability: string | null;
	playabilityReason: string | null;
	play: { type: "youtube"; channelId: string; videoId: string | null } | { type: "audio"; url: string };
	latencyMs: number | null;
}
interface Tally {
	live: number;
	measured: number;
	total: number;
	checkedAt: number | null;
}
export interface LiveTvView {
	cards: LiveCard[];
	tv: Tally;
	radio: Tally;
	ruleEs: string;
	ruleEn: string;
	vantageEs: string;
	vantageEn: string;
	budgets: { tvMs: number; radioMs: number };
}

export const TV_FEED = "youtube-live";
export const RADIO_FEED = "radio-streams";

/** Loads the body chunk once, on the first open panel; a quiet line meanwhile, a retry if it cannot load. */
let loaded: ComponentType<{ view: LiveTvView }> | null = null;
function Body({ view }: { view: LiveTvView }) {
	const [C, setC] = useState(() => loaded);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (C) return;
		import("./LiveTvBody.tsx")
			.then((m) => {
				loaded = m.LiveTvBody;
				setC(() => m.LiveTvBody);
			})
			.catch(() => setFailed(true));
	}, [C]);
	if (C) return <C view={view} />;
	return (
		<p class="note">
			{failed ? (
				<button type="button" class="link-button" onClick={() => setFailed(false)}>
					{t("No se pudo cargar. Reintentar", "Could not load. Retry")}
				</button>
			) : (
				t("Cargando…", "Loading…")
			)}
		</p>
	);
}

export function LiveTvPanel() {
	const view = panels.value.livetv as LiveTvView | undefined;
	const l = lang.value;
	return (
		<Panel
			id="tv"
			title={PANEL_META.tv.title()}
			question={PANEL_META.tv.question()}
			feeds={PANEL_META.tv.feeds()}
			// The list is a directory, shown before any check: it is "not measured", not "waiting".
			whenWaiting={view ? t("Sin medir", "Not measured") : undefined}
			method={
				view ? (
					<>
						<p>{l === "es" ? view.ruleEs : view.ruleEn}</p>
						<p>{l === "es" ? view.vantageEs : view.vantageEn}</p>
						<p>
							{t(
								"Solo canales oficiales de cada medio (verificados por enlaces entre su sitio y su canal), nunca retransmisiones de terceros. Los medios estatales y los financiados por gobiernos llevan su etiqueta. Nada se reproduce solo: el reproductor oficial de YouTube (youtube-nocookie.com) o la señal de la emisora se cargan únicamente al pulsar, y suena una transmisión a la vez (en la pared 2×2, activar el sonido de un recuadro silencia los demás). Al pulsar, YouTube o la emisora reciben su dirección IP, y YouTube también el origen de esta página (sin la ruta): su reproductor no arranca sin él.",
								"Only each outlet's official channels (verified by links between its site and its channel), never third-party re-streams. State and government-funded media carry their label. Nothing autoplays: YouTube's official player (youtube-nocookie.com) or the station's stream loads only on a press, and one stream plays at a time (on the 2×2 wall, turning a tile's sound on mutes the others). On a press, YouTube or the station receives your IP address, and YouTube also this page's origin (not its path): its player will not start without it.",
							)}
						</p>
					</>
				) : null
			}
		>
			{view ? <Body view={view} /> : null}
		</Panel>
	);
}
