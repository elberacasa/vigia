import { airspacePanel } from "../panels/airspace.ts";
import { attentionPanel } from "../panels/attention.ts";
import { briefPanel } from "../panels/brief.ts";
import { censorshipPanel } from "../panels/censorship.ts";
import { connectivityPanel } from "../panels/connectivity.ts";
import { energyPanel } from "../panels/energy.ts";
import { firesPanel } from "../panels/fires.ts";
import { gazettePanel } from "../panels/gazette.ts";
import { hazardsPanel } from "../panels/hazards.ts";
import { humanitarianPanel } from "../panels/humanitarian.ts";
import { incidentsPanel } from "../panels/incidents.ts";
import { liveTvPanel } from "../panels/livetv.ts";
import { marketsPanel } from "../panels/markets.ts";
import { moneyPanel } from "../panels/money.ts";
import { netwatchPanel } from "../panels/netwatch.ts";
import { newsPanel } from "../panels/news.ts";
import { nightlightsPanel } from "../panels/nightlights.ts";
import { oilPanel } from "../panels/oil.ts";
import { pocketPanel } from "../panels/pocket.ts";
import { quakesPanel } from "../panels/quakes.ts";
import { satellitePanel } from "../panels/satellite.ts";
import { servicesPanel } from "../panels/services.ts";
import { weatherPanel } from "../panels/weather.ts";
import type { Panel } from "./panels.ts";

export const PANELS: readonly Panel[] = [
	moneyPanel,
	oilPanel,
	marketsPanel,
	energyPanel,
	airspacePanel,
	attentionPanel,
	connectivityPanel,
	nightlightsPanel,
	censorshipPanel,
	netwatchPanel,
	quakesPanel,
	weatherPanel,
	firesPanel,
	hazardsPanel,
	satellitePanel,
	newsPanel,
	briefPanel,
	incidentsPanel,
	liveTvPanel,
	humanitarianPanel,
	pocketPanel,
	servicesPanel,
	gazettePanel,
] as readonly Panel[];
