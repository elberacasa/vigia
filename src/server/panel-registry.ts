import { airspacePanel } from "../panels/airspace.ts";
import { anomaliesPanel } from "../panels/anomalies.ts";
import { attentionPanel } from "../panels/attention.ts";
import { briefPanel } from "../panels/brief.ts";
import { camerasPanel } from "../panels/cameras.ts";
import { censorshipPanel } from "../panels/censorship.ts";
import { connectivityPanel } from "../panels/connectivity.ts";
import { crowdPanel } from "../panels/crowd.ts";
import { energyPanel } from "../panels/energy.ts";
import { factCheckPanel } from "../panels/factcheck.ts";
import { firesPanel } from "../panels/fires.ts";
import { flightsPanel } from "../panels/flights.ts";
import { floodsPanel } from "../panels/floods.ts";
import { forestPanel } from "../panels/forest.ts";
import { gazettePanel } from "../panels/gazette.ts";
import { gdeltPanel } from "../panels/gdelt.ts";
import { hazardsPanel } from "../panels/hazards.ts";
import { humanitarianPanel } from "../panels/humanitarian.ts";
import { incidentsPanel } from "../panels/incidents.ts";
import { lightningPanel } from "../panels/lightning.ts";
import { liveTvPanel } from "../panels/livetv.ts";
import { marketsPanel } from "../panels/markets.ts";
import { mediaDirPanel } from "../panels/mediadir.ts";
import { methanePanel } from "../panels/methane.ts";
import { monetaryPanel } from "../panels/monetary.ts";
import { moneyPanel } from "../panels/money.ts";
import { netwatchPanel } from "../panels/netwatch.ts";
import { newsPanel } from "../panels/news.ts";
import { nightlightsPanel } from "../panels/nightlights.ts";
import { officialsPanel } from "../panels/officials.ts";
import { oilPanel } from "../panels/oil.ts";
import { pocketPanel } from "../panels/pocket.ts";
import { predictionsPanel } from "../panels/predictions.ts";
import { quakesPanel } from "../panels/quakes.ts";
import { radarPanel } from "../panels/radar.ts";
import { sanctionsPanel } from "../panels/sanctions.ts";
import { satellitePanel } from "../panels/satellite.ts";
import { servicesPanel } from "../panels/services.ts";
import { vesselsPanel } from "../panels/vessels.ts";
import { weatherPanel } from "../panels/weather.ts";
import type { Panel } from "./panels.ts";

export const PANELS: readonly Panel[] = [
	moneyPanel,
	monetaryPanel,
	oilPanel,
	marketsPanel,
	predictionsPanel,
	energyPanel,
	airspacePanel,
	attentionPanel,
	connectivityPanel,
	nightlightsPanel,
	censorshipPanel,
	netwatchPanel,
	quakesPanel,
	weatherPanel,
	lightningPanel,
	firesPanel,
	hazardsPanel,
	satellitePanel,
	newsPanel,
	gdeltPanel,
	factCheckPanel,
	briefPanel,
	incidentsPanel,
	crowdPanel,
	anomaliesPanel,
	camerasPanel,
	liveTvPanel,
	mediaDirPanel,
	humanitarianPanel,
	pocketPanel,
	servicesPanel,
	gazettePanel,
	sanctionsPanel,
	officialsPanel,
	floodsPanel,
	forestPanel,
	methanePanel,
	vesselsPanel,
	radarPanel,
	flightsPanel,
] as readonly Panel[];

/** The space and movement views (branch space-move, 2026-09-29): all on demand, and listed in the client's ON_DEMAND. */
export const SPACE_PANELS: readonly Panel[] = [
	floodsPanel,
	forestPanel,
	methanePanel,
	vesselsPanel,
	radarPanel,
	flightsPanel,
] as readonly Panel[];
