import type { Adapter } from "../core/types.ts";
import { adsbFlights } from "./adsb-flights/index.ts";
import { bcbPtax } from "./bcb-ptax/index.ts";
import { bcvApi } from "./bcv-api/index.ts";
import { bcvHistory } from "./bcv-history/index.ts";
import { bcvInpc } from "./bcv-inpc/index.ts";
import { bcvIntervention } from "./bcv-intervention/index.ts";
import { bcvLiquidity } from "./bcv-liquidity/index.ts";
import { bcvOfficial } from "./bcv-official/index.ts";
import { bcvReserves } from "./bcv-reserves/index.ts";
import { binanceP2p } from "./binance-p2p/index.ts";
import { bybitP2p } from "./bybit-p2p/index.ts";
import { carbonMapper } from "./carbon-mapper/index.ts";
import { cloudflareRadar } from "./cloudflare-radar/index.ts";
import { dahitiGuri } from "./dahiti-guri/index.ts";
import { easaCzib } from "./easa-czib/index.ts";
import { faaProhibitions } from "./faa-prohibitions/index.ts";
import { faoFfpi } from "./fao-ffpi/index.ts";
import { federalRegister } from "./federal-register/index.ts";
import { firmsFires } from "./firms-fires/index.ts";
import { firmsFlares } from "./firms-flares/index.ts";
import { fredMarkets } from "./fred-markets/index.ts";
import { fredOil } from "./fred-oil/index.ts";
import { funvisisQuakes } from "./funvisis-quakes/index.ts";
import { gacetaOficial } from "./gaceta-oficial/index.ts";
import { gdacsEvents } from "./gdacs-events/index.ts";
import { gdeltVe } from "./gdelt-ve/index.ts";
import { gfwAlerts } from "./gfw-alerts/index.ts";
import { gfwVessels } from "./gfw-vessels/index.ts";
import { gibsNightlights } from "./gibs-nightlights/index.ts";
import { goesGlm } from "./goes-glm/index.ts";
import { goesNsa } from "./goes-nsa/index.ts";
import { imfPortwatch } from "./imf-portwatch/index.ts";
import { iodaAsn } from "./ioda-asn/index.ts";
import { iodaEvents } from "./ioda-events/index.ts";
import { iodaStates } from "./ioda-states/index.ts";
import { iptvVe, iptvVeProbe } from "./iptv-ve/index.ts";
import { kalshi } from "./kalshi/index.ts";
import { modisFloods } from "./modis-floods/index.ts";
import { mppsBoletin } from "./mpps-boletin/index.ts";
import { nhcStorms } from "./nhc-storms/index.ts";
import { ochaFts } from "./ocha-fts/index.ts";
import { ofacSdn } from "./ofac-sdn/index.ts";
import { ofacVenezuela } from "./ofac-venezuela/index.ts";
import { ooniMethods } from "./ooni-methods/index.ts";
import { ooniVe } from "./ooni-ve/index.ts";
import { openMeteoWeather } from "./open-meteo-weather/index.ts";
import { polymarket } from "./polymarket/index.ts";
import { portalProbe } from "./portal-probe/index.ts";
import { publicCams } from "./public-cams/index.ts";
import { r4vFigures } from "./r4v-figures/index.ts";
import { radioBrowser, radioBrowserProbe } from "./radio-browser/index.ts";
import { radioStreams } from "./radio-streams/index.ts";
import { reliefwebVe } from "./reliefweb-ve/index.ts";
import { ripeAtlasProbes } from "./ripe-atlas-probes/index.ts";
import { ripestatPrefixes } from "./ripestat-prefixes/index.ts";
import { ripestatRouting } from "./ripestat-routing/index.ts";
import { rssAdapter } from "./rss/factory.ts";
import { OUTLETS } from "./rss/outlets.ts";
import { telegramAdapter } from "./telegram/index.ts";
import { torMetrics } from "./tor-metrics/index.ts";
import { trmColombia } from "./trm-colombia/index.ts";
import { tvLogos } from "./tv-logos/index.ts";
import { tvStills } from "./tv-stills/index.ts";
import { unhcrPopulation } from "./unhcr-population/index.ts";
import { usgsQuakes } from "./usgs-quakes/index.ts";
import { vesinfiltroBlocks } from "./vesinfiltro-blocks/index.ts";
import { wbPinksheet } from "./wb-pinksheet/index.ts";
import { whoGho } from "./who-gho/index.ts";
import { wikiAttention } from "./wiki-attention/index.ts";
import { wikidataOfficials } from "./wikidata-officials/index.ts";
import { windyWebcams } from "./windy-webcams/index.ts";
import { yadio } from "./yadio/index.ts";
import { youtubeLive } from "./youtube-live/index.ts";

/** Every feed Vigía knows. Order is the status page order. */
export const ADAPTERS: readonly Adapter[] = [
	// Money and oil
	bcvOfficial,
	bcvApi,
	bcvHistory,
	bcvInpc,
	bcvLiquidity,
	bcvReserves,
	bcvIntervention,
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
	gfwVessels,
	// Prediction markets (attributed prices, not forecasts)
	polymarket,
	kalshi,
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
	cloudflareRadar,
	portalProbe,
	// Earth
	usgsQuakes,
	funvisisQuakes,
	goesNsa,
	goesGlm,
	openMeteoWeather,
	firmsFires,
	gdacsEvents,
	// Space: methane, floods, forest
	carbonMapper,
	modisFloods,
	gfwAlerts,
	nhcStorms,
	// Airspace and flights
	easaCzib,
	faaProhibitions,
	adsbFlights,
	// Public services and the official record
	dahitiGuri,
	gacetaOficial,
	// Sanctions and official notices (United States)
	ofacSdn,
	ofacVenezuela,
	federalRegister,
	wikidataOfficials,
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
	iptvVe,
	iptvVeProbe,
	tvStills,
	tvLogos,
	publicCams,
	windyWebcams,
	radioBrowser,
	radioBrowserProbe,
	// World news, machine-coded
	gdeltVe,
	// News (outlet feeds, and public Telegram channels read from their web preview)
	...OUTLETS.map((o) => (o.kind === "telegram" ? telegramAdapter(o) : rssAdapter(o))),
] as readonly Adapter[];
