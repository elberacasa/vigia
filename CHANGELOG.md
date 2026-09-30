# Changelog

All notable changes to Vigía are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (0.x: minor versions may break things).

## [1.0.0] - 2026-09-29

The first stable release: everything below works with no key, no payment and no AI model, on Linux, macOS and
Windows. Release notes: [docs/releases/v1.0.0.md](docs/releases/v1.0.0.md).

### Added
- **Every place, facility and institution has a page.** 3,126 entities linked by code (no model): the country, 25
  states, 335 municipalities, 1,134 parishes, 1,328 facilities (power plants, substations, refineries, oil
  terminals, ports, airports, dams, hospitals), internet providers, 224 outlets, 60 institutions and public cameras.
  Each page gathers every signal about it with its source and age, a timeline from 48 hours to a year, nearby
  facilities by distance, and census and WorldPop population side by side. Search finds any of them; a click on the
  map says which parish, municipality and state it is.
- **"Lo inusual ahora":** every numeric series Vigía stores judged against its own history by fixed rules
  (connectivity, rates, reserves, money supply, oil, Tor, Wikipedia attention, fires, lightning…); states that drop
  together are one regional item with each state's own figure; a BCV move the bank took back is labelled so.
- **"¿Tienes luz?":** anonymous reports of power, water, internet and fuel per municipality. No account, no address,
  no coordinates leave the phone; a small proof of work and flood limits make faking them expensive; they only join
  incidents other sources opened, never open one.
- **Live media:** 68 free-to-air TV channels (iptv-org) and 123 radio stations (Radio Browser) checked for liveness,
  with a real still frame of each live channel every 30 minutes (needs ffmpeg), one-click playback, and 11 public
  cameras with their stills.
- **New sources:** BCV money supply, reserves and FX interventions; OFAC Venezuela sanctions, general licences and
  the Federal Register; GOES-19 lightning; Polymarket and Kalshi markets (attributed prices); Wikidata office
  holders; GDELT's raw event files; fact-checkers; Google News for outlets that block feed readers; NASA MODIS
  floods; Global Forest Watch deforestation alerts; Carbon Mapper methane plumes; airline flights seen over and near
  Venezuela; radar ship counts near the oil terminals and Cloudflare Radar (both with a free key).
- Place pages: `/lugar/<estado>` and `/lugar/<estado>/<municipio>`, with every figure's source and age.
- "¿Tu conexión es limitada?": asked once on your own Vigía, it turns off the sources that download 20 MB a day or
  more (8 today: about 1.1 GB a day down to about 255 MB). The switch stays in Personalizar › Mis fuentes and in the
  guide, with the measured download of each choice and what this computer actually downloaded in the last 24 hours;
  your switch for each source still wins. `--data-saver` / `VIGIA_DATA_SAVER=1` fix it from the command line.
- The guide says whether this computer has ffmpeg (needed only for TV stills), with one install line per system,
  and checks again after you install it.
- The Docker image includes a minimal ffmpeg (H.264 decoding only), so TV stills work in a container.
- The earthquake list follows the selected state, like the news.


### Changed
- On a desk (1000 px and wider) Vigía is now a workstation: a command bar with search, a rail of modules (Situación,
  Dinero, Mercados, Internet, Energía, Tierra y clima, Noticias, Oficial, Humanitario, En vivo), the map as the
  canvas, an inspector for the selected place, and a priority list beside an event log. Keys 1–0 open modules.
- The "Ahora" banner is now a priority list: the same rule-built lines, each with a severity word and shape.
- A flatter, calmer look everywhere: hairlines, small radii, one blue accent, amber only for the brand and "live".
- Entity pages (places, facilities, networks, institutions, outlets, cameras) read like a dossier: a strip of key
  facts at the top (people by census and by WorldPop side by side, area, capital or operator or capacity, open
  incidents, unusual readings), then a table of live signals with value, comparison with normal, basis, source, age
  and "desactualizado" on every row; a row opens its full sentence, times and method, and signals with nothing to
  say fold into one line. The inspector uses the same system.

- The rules for sources: any public signal about Venezuela is in scope unless it names private persons, needs a
  login or a bypass, relays paid TV, or tracks individual military craft; a source with unclear terms is on with a
  note and a switch.
- The core needs no AI model at all; every AI feature is optional and off until you add a key or a local model.

### Fixed
- A TV still older than 45 minutes now falls back to the channel's logo instead of its name.
- Why a TV channel has no recent frame is always said in words (Spanish and English), never a code like
  "private-host" or "ended".
- A public camera Vigía keeps no picture of no longer credits "imagen fija tomada por Vigía".
- "Ya es un incidente" (and an incident on an entity page) opens that incident in the incidents panel, not just the
  panel.

- Court notices printed by local papers (edictos, carteles de citación) carried private persons' names and identity
  numbers: they are never stored now, identity numbers are stripped from every headline and summary, and older
  archives are cleaned at start (the sealed archive still verifies).
- A surname or an ordinary phrase is no longer read as a place ("Marco Rubio", "García Márquez", "las mesas de
  diálogo", "Tren de Aragua", "Universidad del Zulia").
- The phone header no longer overflows a 360 px screen; the tablet header stays on one line.
- A day a source never ran is "sin datos", never a count of 0; a count from out-of-date data is a dash.
- Incidents name every source family correctly, and reports never displace the evidence that opened an incident.
- A quake outside Venezuela is tied to news only by its stated magnitude, within 6 hours.
- The desk's source catalogue shows its rows.
- 16 outlets that block feed readers are read through Google News; VE sin Filtro's blocking list is found again.

### Security
- TV and radio liveness checks only reach public hosts (every redirect checked); a listing can no longer make Vigía
  read its own network, and no listing can grow the page's security header until the page stops loading.
- A public mirror does not re-serve TV frames or YouTube thumbnails, does not reveal its ffmpeg version, and keeps
  Kalshi (its terms forbid scraping) and Polymarket (terms unread) off.
- Crowd reports are written per 15-minute block, never one by one, so not even their order is kept.

### Known issues
- The time slider replays the internet layer and the camera stills; other layers show the present.
- "Lo inusual" needs 14 days of history for fires, GDELT and lightning, and camera darkness needs 5 nights.
- Flights: no receiver in Venezuela feeds the open network, so arrivals and departures are rarely seen.
- Keyboard module keys can stop after clicking a checkbox; Preferencias does not close on Escape; the inspector tab
  covers content at 1000–1100 px.

## [0.1.6] - 2026-09-25

### Added
- "Suggest an idea and vote" in the settings menu, linking to GitHub Discussions › Ideas.
- Roadmap in the README: Laya, our own free model, if Vigía grows.

### Fixed
- The AI page said the evaluation labels were made by hand; they come from two language models and an adjudicator.

Release notes: [docs/releases/v0.1.6.md](docs/releases/v0.1.6.md).

## [0.1.5] - 2026-09-25

### Fixed
- Native dropdown lists are readable in the dark theme on browsers that draw them with a light background.

Release notes: [docs/releases/v0.1.5.md](docs/releases/v0.1.5.md).

## [0.1.4] - 2026-09-25

### Added
- Public Telegram channels in the news: 10 verified outlet and institution channels read from their public preview
  (t.me/s), each labelled "(Telegram)" with its outlet's stance and counted as that outlet.
- Personalizar › Mis fuentes: a "Canal de Telegram" field (@nombre or t.me/nombre); `vigia telegram add <canal>`.
- `vigia ia conectar` / `estado` / `desconectar`: checks your Claude Code and uses it for the written daily brief.
- docs/AGENT-SETUP.md: a prompt to paste into your own coding agent to install and set up Vigía.

### Changed
- Contact: GitHub issues and Discussions, or X @elberacasa (README, CONTRIBUTING, SECURITY, Code of Conduct).

### Fixed
- The Red panel's lookup always answers; the routes table fits on phones; history replay no longer shifts the map.

Release notes: [docs/releases/v0.1.4.md](docs/releases/v0.1.4.md).

## [0.1.3] - 2026-09-25

### Added
- `vigia enlace` prints and opens the link that lets this computer's browser change keys and settings.
- The setup guide says up front when this browser can't change settings yet, and what to type.

### Fixed
- The dollar panel's 90-day chart puts BCV and Yadio on one date axis and one price axis; a short Yadio history is
  no longer stretched across 90 days (it looked like a fall that did not happen).

Release notes: [docs/releases/v0.1.3.md](docs/releases/v0.1.3.md).

## [0.1.1] - 2026-09-25

### Fixed
- Satellite panel plays its loop in place; "show on the map" switches the layer.
- Gas-flares layer keeps the layer list compact; map states selectable by keyboard.
- Nine interaction bugs found by a full click-through (collapsed rows, focus under fixed bars, phone overflow during
  replay, Pared density on phones, /fuentes filter bar, Más sheet focus, multi-word search, /guia errors).
- SQLite files are released on close: backups on Windows and restores on macOS work.
- The web client builds on Windows.

### Changed
- YouTube feeds, the YouTube live check and robots-excluded outlets are on by default, each with a note and a switch.
- The Gaceta lists public officials' appointments, promotions and removals with names; private persons' matters and
  every ID number stay withheld.
- bcv-api (github.com/elberacasa/bcv-api) is a second route to the BCV rate on every instance (`VIGIA_BCV_API=0` turns it off).

Release notes: [docs/releases/v0.1.1.md](docs/releases/v0.1.1.md).

## [0.1.0] - 2026-09-25

First public release. Release notes, in Spanish and English: [docs/releases/v0.1.0.md](docs/releases/v0.1.0.md).

### Added

- **303 sources, 299 of them with no key.** Every figure carries its source, licence, observed time and fetched
  time; the status page (`/estado`) shows each feed's health and freshness, and the sources page (`/fuentes`) and
  atlas list who publishes what, under which terms.
- **Money and prices:** the BCV official rate with a second verification route (bcv-api), its history and
  inflation (INPC); parallel-market quotes from named publishers (Yadio; Binance and Bybit P2P medians as opt-in
  sources) side by side with the gap computed in code; oil, Gulf fuels, Henry Hub and the dollar index (via FRED),
  the Colombian and Brazilian official rates, World Bank commodities and the FAO food price index; IMF PortWatch
  arrivals at Venezuelan ports (counts only). **Bolsillo:** every rate named and dated, never averaged, a
  Bs/US$/EUR converter and the minimum wage from the Official Gazette.
- **Internet and power:** connectivity by state and ISP (IODA, RIPE Atlas, RIPEstat routing), censorship
  measurements (OONI, VE sin Filtro) with a per-site blocking timeline and a "¿Está bloqueado?" lookup, Tor usage,
  reachability of government portals (opt-in), and night-time lights (NASA Black Marble via GIBS). **Servicios:**
  the Guri reservoir level from DAHITI altimetry (free key).
- **Earth:** earthquakes (USGS, FUNVISIS), fires and gas flaring at named facilities (NASA FIRMS), weather by state
  (Open-Meteo), disasters (GDACS), tropical storms (NHC), and GOES satellite imagery.
- **Society:** airspace notices (EASA, FAA), the Official Gazette's summaries (general acts, and acts about public officials in office with their names: appointments, promotions, removals, decorations, credentials; pensions and private persons' matters only counted, ID numbers always removed), attention
  (Wikipedia page views), and a **Humanitario** panel: MPPS weekly epidemiological bulletins, WHO figures, R4V and
  UNHCR migration figures side by side, OCHA FTS plan funding, ReliefWeb reports.
- **News:** 256 verified feeds from 221 publishers, regional outlets in 19 states, each outlet's stance labelled,
  located by a gazetteer of every state, municipality and city, grouped into stories; conditional GETs and
  robots.txt checked for every feed (the outlets' YouTube channels and four outlets whose robots.txt excludes feed
  readers are read at a low rate by the project's decision, noted on `/fuentes`). Official TV channels and radio
  streams, click to play, one stream at a time.
- **Incidents** opened only when independent sensor families agree within a time window, with the rule shown in the
  UI and thresholds chosen by a pre-stated criterion over historical blackouts; a daily SHA-256 hash chain over the
  archive, verifiable evidence bundles, and `vigia verify`.
- **Public read API** `/api/v1` with an OpenAPI 3.1 document, CSV/JSON exports and a printable daily report;
  `/metrics`; Docker image, compose file and systemd unit; `vigia backup` and `vigia restore` with verification;
  a read-only public-mirror mode (`--public`).
- **Customisation:** your own feeds (SSRF-safe, kept apart from Vigía's counts), alerts evaluated in code and never
  on stale data, saved views and presets.
- **Terminal mode:** `curl localhost:7722`, `/ahora.txt` and `vigia status`.
- **Setup guide** (`/guia`) that adds and live-checks optional keys and explains each opt-in source.
- **Optional AI section:** a bundled local classifier (free, offline) with measured accuracy shown next to it, and
  optional backends (Ollama, the user's Claude Code, Jev, Anthropic) behind a hard, user-set budget.
- **Phone first:** 84 KiB gzip first load, panels loaded on demand, an offline shell with the last-known data, light
  and dark themes, keyboard accessible.
- **Release binaries** for Linux (x64, ARM64), macOS (Intel, Apple silicon) and Windows (x64), downloaded as
  `.tar.xz` (19–30 MB) or `.zip` (42 MB) archives, with the uncompressed files alongside and `SHA256SUMS` over all;
  `vigia --version`; a tag-driven release workflow that builds and smoke-tests each binary on its own OS.

### Fixed (found running the release binary as a new user)

- A fetch cut short by stopping Vigía (Ctrl+C) is no longer recorded as the source failing; after a restart the
  status page showed such feeds as failing.
- A second Vigía started on a port already in use by another Vigía now stops with the "port in use" message instead
  of sharing the port and answering half of the requests.
- Unknown command-line options (a typo such as `--prot 8080`) stop with a message instead of starting on the
  defaults.

### Known limits

- Incidents detect few blackouts with today's free data (4 of 18 non-minor labelled blackouts in calibration).
- The macOS and Windows binaries were built but not run on real hardware before release.
- See the release notes for the full list.
