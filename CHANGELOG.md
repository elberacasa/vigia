# Changelog

All notable changes to Vigía are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (0.x: minor versions may break things).

## [Unreleased]

## [0.1.0] - 2026-09-25

First public release. Release notes, in Spanish and English: [docs/releases/v0.1.0.md](docs/releases/v0.1.0.md).

### Added

- **303 sources, 260 of them with no key.** Every figure carries its source, licence, observed time and fetched
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
- **Society:** airspace notices (EASA, FAA), the Official Gazette's summaries (acts that name no one), attention
  (Wikipedia page views), and a **Humanitario** panel: MPPS weekly epidemiological bulletins, WHO figures, R4V and
  UNHCR migration figures side by side, OCHA FTS plan funding, ReliefWeb reports.
- **News:** 256 verified feeds from 221 publishers, regional outlets in 19 states, each outlet's stance labelled,
  located by a gazetteer of every state, municipality and city, grouped into stories; conditional GETs and
  robots.txt respected. Official TV channels and radio streams (opt-in), click to play, one stream at a time.
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
