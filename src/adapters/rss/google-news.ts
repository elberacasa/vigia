/**
 * Outlets Vigía cannot read directly, read through Google News `site:` searches (verified 2026-09-28 from this
 * machine; direct feeds answer Cloudflare 403, a SiteGround captcha, or do not exist):
 *
 * | Outlet | Direct | Google News, `when:1d` |
 * |---|---|---|
 * | El Nacional | 403 (Cloudflare, every path) | 100 items (a first try gave 0; retried 100) |
 * | La Patilla | 403 (Cloudflare) | 37 |
 * | El Universal | no feed | 50 |
 * | Últimas Noticias | SiteGround captcha | 100 |
 * | Unión Radio | 403 | 58 |
 * | Banca y Negocios | blocked | 39 |
 * | El Cooperante | blocked | 34 |
 * | Finanzas Digital | blocked | 21 |
 * | NTN24 | blocked | 100 (Colombian channel: only items about Venezuela kept) |
 * | Efecto Cocuyo | 403 since 2026-09-24 (intermittent) | 100 |
 * | Cotejo.info | 200, then 202 captcha, then TLS reset | fallback for the direct feed |
 * | AFP Factual | 403 | fact-checks about Venezuela only (1 in the last 7 days) |
 *
 * Tried and left out: ColombiaCheck (403 direct; through Google News 100 Colombian items a week and one about
 * Venezuela, from 2024), EsPaja (403 direct; Google News lists nothing from espaja.com).
 *
 * Each answer is 20–260 KB, sent `no-store` (no validators): one request per feed every 30–60 min, one request to
 * news.google.com at a time. Links are Google's redirect (`news.google.com/rss/articles/…`) to the article.
 *
 * **On in a person's own Vigía, off on a public mirror** (`defaultIn`, decided 2026-09-28). The feed's own copyright
 * line says: "This XML feed is made available solely for the purpose of rendering Google News results within a
 * personal feed reader for personal, non-commercial use. Any other use of the feed is expressly prohibited." A local,
 * self-hosted Vigía is such a reader; a public mirror (`--public`) is not. The note says so in both modes, and the
 * switch works either way.
 */
import type { OutletSpec } from "./factory.ts";

const MIN = 60_000;

export const GOOGLE_NEWS_NOTE = {
	es:
		"Se lee a través de Google Noticias, cuyo feed solo se permite «en un lector personal, para uso personal y no " +
		"comercial»: encendida en tu propio Vigía, apagada en un espejo público.",
	en:
		"Read through Google News, whose feed is allowed only “within a personal feed reader for personal, " +
		"non-commercial use”: on in your own Vigía, off on a public mirror.",
} as const;

/** A personal reader (local mode) yes, a public mirror no. */
export const PERSONAL_READER_ONLY = { local: true, public: false } as const;

/**
 * A walled outlet's own feed is off in both modes (whole-release review, M12; SAFETY: "if a source blocks us,
 * stop"). In a personal Vigía its Google News route reads it; a public mirror shows it only if the operator switches
 * the direct feed on, and its status then says when the wall refuses it.
 */
export const WALLED_DIRECT = { local: false, public: false } as const;

export const WALLED_NOTE = {
	es:
		"Su servidor rechaza a los lectores automáticos (muro anti-bots, comprobado el 29-09-2026) y Vigía no lo " +
		"sortea: su propio feed está apagado. En tu propio Vigía este medio se lee a través de Google Noticias; en un " +
		"espejo público no se lee.",
	en:
		"Its server refuses automated readers (a bot wall, checked 2026-09-29) and Vigía does not get around it. In " +
		"its own feed is off. In your own Vigía this outlet is read through Google News; on a public mirror it is not " +
		"read.",
} as const;

function search(host: string, window: "1d" | "7d"): string {
	return `https://news.google.com/rss/search?q=site:${host}+when:${window}&hl=es-419&gl=VE&ceid=VE:es-419`;
}

type Spec = Omit<OutletSpec, "url" | "kind" | "via" | "optIn" | "note" | "defaultIn"> & {
	readonly host: string;
	readonly window?: "1d" | "7d";
};

function gn(spec: Spec): OutletSpec {
	const { host, window = "1d", ...rest } = spec;
	return {
		...rest,
		url: search(host, window),
		kind: "rss",
		via: { kind: "google-news", host },
		note: GOOGLE_NEWS_NOTE,
		defaultIn: PERSONAL_READER_ONLY,
	};
}

export const GOOGLE_NEWS_OUTLETS: readonly OutletSpec[] = [
	gn({
		id: "gn-el-nacional",
		name: "El Nacional",
		host: "elnacional.com",
		region: "national",
		stance: "commercial",
		homepage: "https://www.elnacional.com/",
		intervalMs: 30 * MIN,
	}),
	gn({
		id: "gn-la-patilla",
		name: "La Patilla",
		host: "lapatilla.com",
		region: "national",
		stance: "commercial",
		homepage: "https://lapatilla.com/",
		intervalMs: 30 * MIN,
	}),
	gn({
		id: "gn-el-universal",
		name: "El Universal",
		host: "eluniversal.com",
		region: "national",
		stance: "commercial",
		homepage: "https://www.eluniversal.com/",
		intervalMs: 30 * MIN,
	}),
	gn({
		id: "gn-ultimas-noticias",
		name: "Últimas Noticias",
		host: "ultimasnoticias.com.ve",
		region: "national",
		stance: "state-aligned",
		homepage: "https://ultimasnoticias.com.ve/",
		intervalMs: 30 * MIN,
	}),
	gn({
		id: "gn-union-radio",
		name: "Unión Radio",
		host: "unionradio.net",
		region: "national",
		stance: "commercial",
		homepage: "https://unionradio.net/",
		intervalMs: 30 * MIN,
	}),
	gn({
		id: "gn-banca-y-negocios",
		name: "Banca y Negocios",
		host: "bancaynegocios.com",
		region: "national",
		stance: "independent",
		homepage: "https://www.bancaynegocios.com/",
		intervalMs: 60 * MIN,
	}),
	gn({
		id: "gn-el-cooperante",
		name: "El Cooperante",
		host: "elcooperante.com",
		region: "national",
		stance: "commercial",
		homepage: "https://elcooperante.com/",
		intervalMs: 60 * MIN,
	}),
	gn({
		id: "gn-finanzas-digital",
		name: "Finanzas Digital",
		host: "finanzasdigital.com",
		region: "national",
		stance: "commercial",
		homepage: "https://finanzasdigital.com/",
		intervalMs: 60 * MIN,
	}),
	gn({
		id: "gn-ntn24",
		name: "NTN24",
		host: "ntn24.com",
		region: "international",
		stance: "commercial",
		homepage: "https://www.ntn24.com/",
		country: "CO",
		onlyVenezuela: true,
		publisher: "yt-ntn24",
		intervalMs: 30 * MIN,
	}),
	gn({
		id: "gn-efecto-cocuyo",
		name: "Efecto Cocuyo",
		host: "efectococuyo.com",
		region: "national",
		stance: "independent",
		homepage: "https://efectococuyo.com/",
		publisher: "efecto-cocuyo",
		intervalMs: 30 * MIN,
	}),
	// Fact-checkers.
	gn({
		id: "gn-cotejo",
		name: "Cotejo.info",
		host: "cotejo.info",
		window: "7d",
		region: "national",
		stance: "ngo",
		homepage: "https://cotejo.info/",
		genre: "fact-check",
		publisher: "cotejo",
		intervalMs: 120 * MIN,
	}),
	// Outlets whose own feed is behind a bot wall (measured 2026-09-29 from this machine, one request each with the
	// project User-Agent): 415 "Unsupported Media Type" from the host's firewall (openresty or nginx, some behind
	// Cloudflare) on 14 feeds; a JavaScript cookie challenge (`/aes.js`) served as the feed on Armando.info and
	// Espacio Público. Google News items in the window (kept after the host filter), same day: Armando.info 7 in 7 days,
	// Espacio Público 4, Cecodap 4, Cepaz 3, NaGuara 4; El Tigrense 13 in 1 day, Notiapure 16, InfoSur 6 (+2 index
	// pages), El Carabobeño 35 (+61 re-indexed pages older than three days), Ciudad BQTO 5, Comunicación Continua 11,
	// La Revista del Tuy 11, TuyInforma 2, Digital 58 7, Al Navío 41; Mala Espina 83 in 7 days (Chilean; only items
	// about Venezuela kept). Fedeagro is not here: Google News lists 1 item in 30 days.
	gn({
		id: "gn-armando-info",
		name: "Armando.info",
		host: "armando.info",
		window: "7d",
		region: "national",
		stance: "independent",
		homepage: "https://armando.info/",
		publisher: "armando-info",
		intervalMs: 180 * MIN,
	}),
	gn({
		id: "gn-espacio-publico",
		name: "Espacio Público",
		host: "espaciopublico.ong",
		window: "7d",
		region: "national",
		stance: "ngo",
		homepage: "https://espaciopublico.ong/",
		genre: "rights",
		publisher: "espacio-publico",
		intervalMs: 180 * MIN,
	}),
	gn({
		id: "gn-cecodap",
		name: "Cecodap",
		host: "cecodap.org",
		window: "7d",
		region: "national",
		stance: "ngo",
		homepage: "https://cecodap.org/",
		genre: "rights",
		publisher: "cecodap",
		intervalMs: 180 * MIN,
	}),
	gn({
		id: "gn-cepaz",
		name: "Cepaz",
		host: "cepaz.org",
		window: "7d",
		region: "national",
		stance: "ngo",
		homepage: "https://cepaz.org/",
		genre: "rights",
		publisher: "cepaz",
		intervalMs: 180 * MIN,
	}),
	gn({
		id: "gn-diario-el-tigrense",
		name: "Diario El Tigrense (Anzoátegui)",
		host: "diarioeltigrense.com",
		region: "VE-B",
		stance: "commercial",
		homepage: "https://www.diarioeltigrense.com/",
		publisher: "diario-el-tigrense",
		intervalMs: 30 * MIN,
	}),
	gn({
		id: "gn-notiapure",
		name: "Notiapure (Apure)",
		host: "notiapure.com.ve",
		region: "VE-C",
		stance: "commercial",
		homepage: "https://notiapure.com.ve/",
		publisher: "notiapure",
		intervalMs: 30 * MIN,
	}),
	gn({
		id: "gn-infosur-guayana",
		name: "InfoSur Guayana (Bolívar)",
		host: "infosurguayana.com.ve",
		region: "VE-F",
		stance: "commercial",
		homepage: "https://infosurguayana.com.ve/",
		publisher: "infosur-guayana",
		intervalMs: 60 * MIN,
	}),
	gn({
		id: "gn-el-carabobeno",
		name: "El Carabobeño (Carabobo)",
		host: "el-carabobeno.com",
		region: "VE-G",
		stance: "independent",
		homepage: "https://www.el-carabobeno.com/",
		publisher: "el-carabobeno",
		intervalMs: 30 * MIN,
	}),
	gn({
		id: "gn-ciudad-bqto",
		name: "Ciudad BQTO (Lara)",
		host: "ciudadbqto.com",
		region: "VE-K",
		stance: "state",
		homepage: "https://www.ciudadbqto.com/",
		publisher: "ciudad-bqto",
		intervalMs: 60 * MIN,
	}),
	gn({
		id: "gn-naguara",
		name: "NaGuara (Lara)",
		host: "naguara.com",
		window: "7d",
		region: "VE-K",
		stance: "commercial",
		homepage: "https://naguara.com/",
		publisher: "naguara",
		intervalMs: 180 * MIN,
	}),
	gn({
		id: "gn-comunicacion-continua",
		name: "Comunicación Continua (Mérida)",
		host: "comunicacioncontinua.com",
		region: "VE-L",
		stance: "independent",
		homepage: "https://comunicacioncontinua.com/",
		publisher: "comunicacion-continua",
		intervalMs: 60 * MIN,
	}),
	gn({
		id: "gn-la-revista-del-tuy",
		name: "La Revista del Tuy (Miranda)",
		host: "larevistadeltuy.com",
		region: "VE-M",
		stance: "commercial",
		homepage: "https://larevistadeltuy.com/",
		publisher: "la-revista-del-tuy",
		intervalMs: 60 * MIN,
	}),
	gn({
		id: "gn-tuy-informa",
		name: "TuyInforma (Miranda)",
		host: "tuyinforma.com",
		region: "VE-M",
		stance: "commercial",
		homepage: "https://www.tuyinforma.com/",
		publisher: "tuy-informa",
		intervalMs: 120 * MIN,
	}),
	gn({
		id: "gn-digital-58",
		name: "Digital 58 (Zulia)",
		host: "digital58.com.ve",
		region: "VE-V",
		stance: "commercial",
		homepage: "https://digital58.com.ve/",
		publisher: "digital-58",
		intervalMs: 60 * MIN,
	}),
	gn({
		id: "gn-al-navio",
		name: "Al Navío",
		host: "alnavio.es",
		region: "diaspora",
		stance: "commercial",
		homepage: "https://alnavio.es/",
		publisher: "al-navio",
		intervalMs: 30 * MIN,
	}),
	gn({
		id: "gn-mala-espina",
		name: "Mala Espina Check",
		host: "malaespinacheck.cl",
		window: "7d",
		region: "international",
		stance: "independent",
		homepage: "https://www.malaespinacheck.cl/",
		genre: "fact-check",
		onlyVenezuela: true,
		publisher: "mala-espina",
		intervalMs: 120 * MIN,
	}),
	gn({
		id: "gn-afp-factual",
		name: "AFP Factual",
		host: "factual.afp.com",
		window: "7d",
		region: "international",
		stance: "agency",
		homepage: "https://factual.afp.com/",
		country: "FR",
		genre: "fact-check",
		onlyVenezuela: true,
		intervalMs: 120 * MIN,
	}),
];
