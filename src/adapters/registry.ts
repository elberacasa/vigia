import type { Adapter } from "../core/types.ts";
import { bcbPtax } from "./bcb-ptax/index.ts";
import { bcvApi } from "./bcv-api/index.ts";
import { bcvHistory } from "./bcv-history/index.ts";
import { bcvInpc } from "./bcv-inpc/index.ts";
import { bcvOfficial } from "./bcv-official/index.ts";
import { binanceP2p } from "./binance-p2p/index.ts";
import { bybitP2p } from "./bybit-p2p/index.ts";
import { dahitiGuri } from "./dahiti-guri/index.ts";
import { easaCzib } from "./easa-czib/index.ts";
import { faaProhibitions } from "./faa-prohibitions/index.ts";
import { faoFfpi } from "./fao-ffpi/index.ts";
import { firmsFires } from "./firms-fires/index.ts";
import { firmsFlares } from "./firms-flares/index.ts";
import { fredMarkets } from "./fred-markets/index.ts";
import { fredOil } from "./fred-oil/index.ts";
import { funvisisQuakes } from "./funvisis-quakes/index.ts";
import { gacetaOficial } from "./gaceta-oficial/index.ts";
import { gdacsEvents } from "./gdacs-events/index.ts";
import { gibsNightlights } from "./gibs-nightlights/index.ts";
import { goesNsa } from "./goes-nsa/index.ts";
import { imfPortwatch } from "./imf-portwatch/index.ts";
import { iodaAsn } from "./ioda-asn/index.ts";
import { iodaEvents } from "./ioda-events/index.ts";
import { iodaStates } from "./ioda-states/index.ts";
import { mppsBoletin } from "./mpps-boletin/index.ts";
import { nhcStorms } from "./nhc-storms/index.ts";
import { ochaFts } from "./ocha-fts/index.ts";
import { ooniMethods } from "./ooni-methods/index.ts";
import { ooniVe } from "./ooni-ve/index.ts";
import { openMeteoWeather } from "./open-meteo-weather/index.ts";
import { portalProbe } from "./portal-probe/index.ts";
import { r4vFigures } from "./r4v-figures/index.ts";
import { radioStreams } from "./radio-streams/index.ts";
import { reliefwebVe } from "./reliefweb-ve/index.ts";
import { ripeAtlasProbes } from "./ripe-atlas-probes/index.ts";
import { ripestatPrefixes } from "./ripestat-prefixes/index.ts";
import { ripestatRouting } from "./ripestat-routing/index.ts";
import { rssAdapter } from "./rss/factory.ts";
import { OUTLETS } from "./rss/outlets.ts";
import { torMetrics } from "./tor-metrics/index.ts";
import { trmColombia } from "./trm-colombia/index.ts";
import { unhcrPopulation } from "./unhcr-population/index.ts";
import { usgsQuakes } from "./usgs-quakes/index.ts";
import { vesinfiltroBlocks } from "./vesinfiltro-blocks/index.ts";
import { wbPinksheet } from "./wb-pinksheet/index.ts";
import { whoGho } from "./who-gho/index.ts";
import { wikiAttention } from "./wiki-attention/index.ts";
import { yadio } from "./yadio/index.ts";
import { youtubeLive } from "./youtube-live/index.ts";

/** Every feed Vigía knows. Order is the status page order. */
export const ADAPTERS: readonly Adapter[] = [
	// Money and oil
	bcvOfficial,
	bcvApi,
	bcvHistory,
	bcvInpc,
	yadio,
	binanceP2p,
	bybitP2p,
	fredOil,
	firmsFlares,
	// Markets and cargo
	fredMarkets,
	trmColombia,
	bcbPtax,
	wbPinksheet,
	faoFfpi,
	imfPortwatch,
	// Power and internet
	iodaStates,
	iodaAsn,
	iodaEvents,
	ripeAtlasProbes,
	ripestatRouting,
	ripestatPrefixes,
	gibsNightlights,
	ooniVe,
	ooniMethods,
	vesinfiltroBlocks,
	torMetrics,
	portalProbe,
	// Earth
	usgsQuakes,
	funvisisQuakes,
	goesNsa,
	openMeteoWeather,
	firmsFires,
	gdacsEvents,
	nhcStorms,
	// Airspace
	easaCzib,
	faaProhibitions,
	// Public services and the official record
	dahitiGuri,
	gacetaOficial,
	// Attention
	wikiAttention,
	// Health, migration and aid
	mppsBoletin,
	whoGho,
	r4vFigures,
	unhcrPopulation,
	ochaFts,
	reliefwebVe,
	// Live TV and radio
	youtubeLive,
	radioStreams,
	// News
	...OUTLETS.map(rssAdapter),
] as readonly Adapter[];
