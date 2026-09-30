# Performance

Performance is a feature: many users open Vigía on a cheap phone over a slow connection. Every number here is
measured, never estimated; newest at the bottom of each table. Unless noted, the machine is an x64 Linux desktop
over local loopback. Reproduce the slow-phone figures with `bun scripts/perf.ts`, and the transfer sizes with
`bun scripts/build-web.ts` (it prints gzip sizes).

## Slow phone (`bun scripts/perf.ts`)

Profile: 390×844 at 2× density, Chrome throttling to 400 kbit/s down, 150 kbit/s up, 400 ms round trip, CPU 4×
slower. "Data on screen" is when the rule-built "Ahora" line renders (it needs the connectivity, money, quakes and
weather panels).

| Date | Change | First paint | Data on screen | Transferred |
|---|---|---|---|---|
| 2026-09-24 | all layers, one `/api/panels` call after `/api/meta` | 2,836 ms | 5,403 ms | 191.1 KiB |
| 2026-09-24 | parallel start; small panels first (23 KB gz), heavy lists (news 32 KB, censorship 10 KB) after | 2,856 ms | 4,425 ms | 146.0 KiB |
| 2026-09-24 | static boot shell in the HTML (mark + "Cargando…") | 1,524 ms | 4,445 ms | 146.4 KiB |
| 2026-09-24 | no font preload (fonts swap in; the script and data get the thin link first) | 1,228 ms | 4,306 ms | 146.4 KiB |
| 2026-09-24 | repeat visit (service worker shell + last-known data) | 40 ms | 240 ms | 0 KiB |
| 2026-09-24 | same profile, same stored snapshot, previous client (baseline for the next row) | 1,224 ms | 4,422 ms | 150.5 KiB |
| 2026-09-24 | layout and panel chrome: static page skeleton in the HTML (header, "Ahora" bar, map silhouette, panel frames; 2.1 KiB gz), phone panels start as summary rows, collapse/hide/reorder, help sheet, tab bar. Client 67.5 → 80.3 KiB gz. First paint now shows the product's shape; phone page height 10,812 → 1,528 CSS px, DOM elements 1,877 → 462 | 1,372 ms | 4,771 ms | 163.4 KiB |
| 2026-09-24 | code splitting: the five secondary pages (estado, fuentes, guía, IA, resumen) load on demand in their own chunks (10.9 KiB gz); first-load JS 68.2 → 61.9 KiB gz, first-load total ≈ 75.7 KiB gz (JS 61.9 + CSS 11.6 + HTML 2.2), of which 17.0 KiB is the state geometry. Timings not re-run (same critical path minus 6.3 KiB) | — | — | — |
| 2026-09-24 | command palette, shortcuts, status bar, "new" marks, rolling digits, news clusters: first load 81.3 KiB gz (JS 66.9, CSS 13.9); on demand 23.1 KiB (palette search 9.4 after 6 s idle or first open; status bar and shortcuts 3.3 only at ≥ 1000 px wide; secondary pages 10.9). Phone page width checked after tab jumps: 390 px, no sideways scroll | — | — | — |
| 2026-09-24 | seven branches merged (baseline for the next rows; same profile, same stored snapshot served with `--no-fetch`): first load 107.1 KiB gz (JS 87.9, CSS 19.4); Netwatch alone was 19 KB raw in the entry | 1,664 ms | 5,810 ms | 197.3 KiB |
| 2026-09-24 | trim: every wall panel's body is its own chunk, loaded when open and within 600 px of the view (at idle on wider screens); the collapsed phone rows come from lib/summary.ts and lib/panel-meta.ts; source/method sheets, state sheet and onboarding on demand. Entry JS 87.9 → 64.8 KiB | — | — | — |
| 2026-09-24 | trim: per-feature CSS travels with its chunk (`x.css?inline` + lib/css.ts; Bun copies lazy CSS into the entry sheet otherwise). Entry CSS 19.4 → 11.1 KiB (10.2 once the clean view's styles also moved); computed styles of every element (1920/800/390, six pages, seven dialogs) unchanged | 1,300 ms | 5,277 ms | 167.4 KiB |
| 2026-09-24 | trim: `/api/panels` (light), `/api/meta`, `/api/health` preloaded from the HTML; the app stylesheet preloaded instead of render-blocking (the static shell is styled inline; main.tsx applies the sheet before rendering). First load 75.9 KiB gz (JS 63.1, CSS 10.2, HTML 2.3) against 107.1 | 484 ms | 3,450 ms | 115.8 KiB |
| 2026-09-24 | trim, repeat visit 1.5 s after the first (worker registered once the app is on screen, installs with the page only, precaches the 35 on-demand files and fonts after the first data) | 52–60 ms | 166–183 ms | 0 KiB |
| 2026-09-25 | master (markets, live TV, atlas pages, bcv-api, honesty fixes) merged into trim; markets and live TV bodies and the atlas styles on demand. First load 78.7 KiB gz (master alone 115.5); the light `/api/panels` grew, so data arrives later | 484 ms | 3,770 ms | 124.6 KiB |
| 2026-09-25 | same, repeat visit | 48–52 ms | 161–162 ms | 0 KiB |
| 2026-09-28 | baseline for the next rows: master at 6d13c9e, served from a copy of the live archive with `--no-fetch` (one run) | 500 ms | 4,764 ms | 173.4 KiB |
| 2026-09-28 | workstation branch: the priority list replaced the Ahora line, so "data on screen" is now when the list renders (`.prio__list`, the same rule-built clauses); first load 84.4 → 86.1 KiB gz (priority list, module table, router, preferences menu); the desk shell is not in the first load below 1000 px (the worker precaches it later with the other on-demand chunks; one run) | 492 ms | 4,808 ms | 175.1 KiB |
| 2026-09-28 | same, repeat visit | 80 ms | 204 ms | 0 KiB |
| 2026-09-28 | workstation after the review fixes, a fresher copy of the archive (larger panels, so not strictly comparable with the rows above); first load 86.6 KiB gz (one run) | 508 ms | 4,950 ms | 177.0 KiB |
| 2026-09-28 | ui-live: TV wall and radio, GDELT, fact-checks and the five sources-data panels (nine new panels, all on demand: none in the bulk `/api/panels`), a fresh archive copy plus the new adapters' rows; first load 88.2 KiB gz (one run) | 576 ms | 5,018 ms | 188.9 KiB |
| 2026-09-28 | same, repeat visit | 100 ms | 224 ms | 0 KiB |
| 2026-09-29 | ui-entities: entity pages, inspector, palette search and facilities layer on the ontology API, all on demand (page 5.9 KiB gz, inspector 1.6, timeline and view in shared chunks; facilities data 21.5 KiB gz, health centres 18.4 only when that group is shown). First load 88.2 → 88.9 KiB gz (router's entity paths, selection state, the layer's row, tab bar on pages); a fresh copy of the live archive plus the sources-data rows (one run) | 572 ms | 4,883 ms | 184.7 KiB |
| 2026-09-29 | same, repeat visit | 76 ms | 178 ms | 0 KiB |
| 2026-09-29 | an entity page opened cold: `/lugar/zulia` (data on screen = its facts grid, `PERF_WAIT='.entity--page:not(.entity--loading) .facts'`) | 576 ms | 4,970 ms | 184.7 KiB |
| 2026-09-29 | `/infra/guri`, same rule (the server's view is its only source: no panel fallback for a facility) | 576 ms | 5,873 ms | 188.8 KiB |
| 2026-09-29 | `/infra/guri` on the desk (1440×900, `PERF_VIEW=desk`); the room itself on the desk: 592 / 5,485 ms / 197.4 KiB | 580 ms | 6,385 ms | 201.6 KiB |
| 2026-09-29 | ui-entities after the independent review's fixes (the map zooms to a municipality, so `pathBox` joins the entry; the facility marks keep one vnode while nothing changes; entity views on the 15 s tick instead of the 1 s clock): first load 89.2 KiB gz (one run) | 572 ms | 4,984 ms | 189.0 KiB |
| 2026-09-29 | same, `/infra/guri` cold | 576 ms | 5,874 ms | 193.2 KiB |
| 2026-09-29 | ui-signals merged with master (crowd report entry, "lo inusual", TV stills, cameras, six space panels, all on demand; the new layer rows, the flare/lightning/facility rows and the map's method text moved out of the entry): first load 90.0 KiB gz; the same archive copy plus 5.5 h of stills and the space rows (one run) | 576 ms | 5,151 ms | 197.4 KiB |
| 2026-09-29 | same, repeat visit | 100 ms | 216 ms | 0 KiB |
| 2026-09-29 | `/camara/charallave-oeste` cold (data on screen = the still, `PERF_WAIT='.cam-still img'`; its stills strip loads after) | 588 ms | 6,987 ms | 256.9 KiB |
| 2026-09-29 | ficha: the entity page as a dossier (key strip, signals table), `/lugar/zulia` cold, data on screen = the table (`PERF_WAIT='.entity--page:not(.entity--loading) .sigt'`); the base commit f1ae706 on the same archive copy, alternated run by run, gave 5,394 and 4,974 ms against the ficha's 5,387 and 4,975 (the tiles' `.facts` marker): no change. Entity view chunk 21.4 → 30.7 KiB gz (on demand: the table's and strip's words in two languages, JS +8.5, CSS +0.9); first load 90.0 → 90.1 KiB gz (the incident focus in `lib/keys.ts`) | 576 ms | 4,952 ms | 192.4 KiB |
| 2026-09-29 | same, `/infra/guri` cold (three runs: 5,980, 6,008 and one outlier at 6,376; the base gave 5,926 and 5,925) | 572 ms | 5,980 ms | 198.9 KiB |
| 2026-09-29 | same, repeat visits (`/lugar/zulia`, `/infra/guri`) | 56–104 ms | 161–226 ms | 0 KiB |

### Desk (1440×900, the same slow link and CPU: `PERF_VIEW=desk bun scripts/perf.ts`)

The desk's workstation shell is a chunk of its own (10.5 KiB gzip with its styles). Same snapshot, one run each.

| Date | Change | First paint | Data on screen | Transferred |
|---|---|---|---|---|
| 2026-09-28 | master at 6d13c9e (the wall; marker `.ahora__text`) | 488 ms | 4,772 ms | 173.4 KiB |
| 2026-09-28 | workstation, the shell fetched after the entry script | 484 ms | 5,802 ms | 186.1 KiB |
| 2026-09-28 | workstation, the shell `modulepreload`ed from the HTML with `media="(min-width: 1000px)"` | 500 ms | 5,221 ms | 186.2 KiB |
| 2026-09-28 | same, after the review fixes, fresher archive copy | 504 ms | 5,036 ms | 188.3 KiB |
| 2026-09-28 | ui-live (Situación; the new panels load only when their module opens) | 596 ms | 5,369 ms | 200.6 KiB |
| 2026-09-29 | ui-signals (Situación with "lo inusual" in the inspector: the anomalies view is fetched with it) | 592 ms | 5,865 ms | 210.2 KiB |
| 2026-09-29 | ficha: `/infra/guri` on the desk, data on screen = the signals table (`.sigt`) | 576 ms | 6,899 ms | 211.7 KiB |

The remaining 0.45 s is the shell's own bytes on a 400 kbit/s link; on a desk's usual connection it is a few
milliseconds. The static shell in `index.html` draws the workstation's silhouette (rail, strip, inspector) so the
first paint already has the right shape.

"Transferred" counts what the page itself fetched until 1.5 s after data on screen, so rows before and after the
preloads are not strictly comparable (the heavy lists now finish inside that window, the fonts and the worker's
background precache do not). The 44 KiB budget of the first rows no longer holds with the full map geometry (17 KiB
gz), Preact and signals (10 KiB) and the first screen's panels and styles; what matters on the slow profile is the
critical path above. Offline behaviour is checked by `bun scripts/offline.ts` (worker precache, offline home after
visiting /ahora.txt and a 404, a panel body and /guia from the cache).

## Transfer sizes (first load)

| Date | What | Raw | Gzip | Notes |
|---|---|---|---|---|
| 2026-09-24 | Web shell (Preact + signals) | 11 KB | 4.6 KB | before any panel |
| 2026-09-24 | Client with map, news, quakes, guide, status | 102 KB JS + 23 KB CSS | 44.1 KiB | map geometry (states + neighbours) is ~17 KB gz of that |
| 2026-09-24 | Fonts | 28.4 + 18.2 KB woff2 | (already compressed) | `font-display: swap`; first paint does not wait |
| 2026-09-24 | `/api/panels` (quakes + news, 76 feeds) | 82.8 KB | 9.9 KB | gzip on every JSON response > 1 KB |
| 2026-09-28 | Workstation branch, first load (JS + CSS + HTML) | | 86.6 KiB | on demand: the desk-only shell 10.5 KiB, the place page 1.0, the keys sheet 1.5 |
| 2026-09-28 | ui-live, first load | | 88.2 KiB | +1.6: nine panel frames (title, question, feeds, loader), the on-demand fetch, the desk column choice, the Rayos layer row. Kept out: the on-demand panels' summaries (registered by their chunks), the desk arrangement (in the shell), the flare and lightning layers (chunks loaded when switched on; the flare layer was in the first load before) |

On demand (gzip), ui-live, 2026-09-28. Chunks: TV and radio 11.2 KiB, hls.js light 116.7 KiB (self-hosted; fetched
only when a press needs it: a browser without native HLS; Chromium and Safari play natively), GDELT 3.3, fact-checks
1.6, monetary 3.4, predictions 2.4, sanctions and offices 8.9, lightning 4.6, its map layer 0.9, the flare layer 0.8.
Views, fetched when their panel opens and then only on the stream's word while it stays asked for: `mediadir`
125.4 KB raw / 20.0 KB gzip, `sanctions` 14.7, `desmentidos` 6.9, `monetary` 5.8, `gdelt` 4.8, `predictions` 4.0,
`officials` 2.9, `lightning` 1.2. None is kept in the last-known cache (localStorage).

Per-panel JSON, gzip (live, 2026-09-24): news 32.2 KB, connectivity 11.6, censorship 9.9, quakes 3.8, night lights
3.3, weather 2.7, money 2.6, fires 1.7, satellite 1.3, hazards 1.2, oil 0.8.

## Server

| Date | What | Result |
|---|---|---|
| 2026-09-24 | `locate(lat, lon)` (state and municipality point-in-polygon) | 23 µs per point |
| 2026-09-24 | `/api/panels` compute with 76 feeds, ~1,800 news items in 48 h | 0.11 s end to end, cached until a source changes |
| 2026-09-24 | USGS run (fetch + validate + store) | 266 ms |
| 2026-09-24 | Sealing 6 days / 509k rows (a local benchmark on a 509k-row test archive), before: synchronous at startup | 3.7 s with the event loop blocked the whole time (snapshot, 124k rows: 1.36 s) |
| 2026-09-24 | Same, after: sliced in the background (15 ms slices, keyset-paged 4k-row chunks, day's row hashes kept as one blob) | 3.1–3.4 s total; longest event-loop block 225–450 ms (the WAL checkpoint after writing a day's 2.7 MB of kept hashes) |
| 2026-09-24 | Upgrade of the same archive sealed with format 1 (backfilling kept hashes) | 4.1 s in the background; `vigia verify` of the chain 2.5 s (CLI) |
| 2026-09-24 | Slowest `/api/meta` while a server starts on that archive (unsealed; polled every 20 ms for 6 s) | before 3,530 ms; after 258–688 ms (same archive already sealed: 420 ms, start-up noise) |
| 2026-09-24 | A bundle's day tree (85k rows): re-hashing the day vs from kept hashes | 472 ms → 150 ms (then cached) |
| 2026-09-25 | `/api/v1` read API, snapshot data, `bun scripts/perf-api.ts` (20 sequential requests per route after 3 warm-ups, gzip, paced under the rate limit) | p50 / p95: index 0.6 / 2.1 ms; health 2.3 / 4.0; panel money 0.8 / 0.9; money figures CSV 1.1 / 2.2 (2.5 KiB gz); all figures CSV (~3,700 rows) 10.6 / 12.2 (52 KiB gz); sources 1.5 / 2.4; incidents 1.0 / 1.2; connectivity history 1d 0.7 / 0.8 (cached 60 s; a cold 1d replay was 774 ms); openapi.json 1.0 / 1.3 (5.2 KiB gz); `/informe` 2.6 / 4.2 (7.9 KiB gz) |
| 2026-09-25 | CSV responses gzipped (were not: text/csv missing from the compressible types) | money figures CSV 42.0 KB → 2.5 KB |
| 2026-09-25 | `vigia backup` / `vigia restore`, 47 MB archive (124,331 observations, 1 sealed day) | backup 0.36 s on the host with Vigía running (VACUUM INTO + verification); restore 1.6 s (hash, verify, swap, re-verify). In the container: 2.8 s and 1.4 s |
| 2026-09-25 | Graceful stop (SIGTERM) with a request in flight | request answered 200 in full; process closed in 135 ms; `docker stop` 386 ms |
| 2026-09-28 | Entity registry build (3,126 entities: places, facilities, networks, outlets, institutions), first use | 38–43 ms; search 1–3 ms; `/api/v1/locate` 0.7 ms |
| 2026-09-28 | Linking a copy of the live archive (257,785 observations, 4 days) into `entity_links` | 2.1 s in one piece (41,879 links, 3.7 MB table + index); in the server, sliced in the background: backlog 218k → 0 in about 10 s |
| 2026-09-28 | The alternative, computing links per request: re-tagging 7 days of headlines (10,395) | 1.4 s per request, so links are stored (a timeline from the table: 0.1–2.5 ms) |
| 2026-09-28 | Entity API on that copy (`--no-fetch` server, 12 sequential requests per route after one warm-up, gzip) | p50 / p95: state 3.6 / 4.6 ms (8.1 KiB gz); municipality 3.4 / 43 (7.5 KiB); parish 3.1 / 42; country 2.7 / 3.4 (10.4 KiB); facility 1.3 / 41; ISP 1.2 / 41; institution 2.8 / 4.4; outlet 1.8 / 52; state timeline 4.2 / 8.3 (12.6 KiB); search 2.5 / 3.2. The p95 is the 10 s feed-health cache refreshing (health of 313 feeds: ~40 ms, which was every request's cost before the cache) |
| 2026-09-28 | After review: source filter and revision rule in SQL, exact counts (same copy) | full link 38,643 links in 2.5 s (3.5 MB); timeline 0.1–1.9 ms; count of the country's 7 days 4.6 ms; entity pages p50 1.4–7.0 ms (state 7.0, it now counts exactly); rare p95 spikes up to 0.5 s when a panel's 60 s cache expires during the request (inst.bcv reads the money panel's figures) |
| 2026-09-28 | Rules v4 (new sources linked), copy of the ui-live archive (264,127 observations) | full link 40,433 links in 4.7 s (874 from the new sources) |
| 2026-09-28 | Anomaly engine ("lo inusual ahora"), same copy, in-process | panel compute 20 ms p50, 102 ms max (235 series; the connectivity view it reads costs 191 ms but comes from that panel's cache); replay: 190 ms per hourly tick including a fresh connectivity view. The archive holds only 5 days of Yadio, Binance, headlines and GDELT: readers take the day's close and GDELT's batches in SQL so the cost follows days, not polls; re-measure when a month is stored |
| 2026-09-28 | Entity API and `/api/v1/anomalies` on that copy (`--no-fetch` server, 12 sequential requests after 3 warm-ups, gzip) | p50 / p95: anomalies 0.6 / 0.7 ms (2.1 KiB); country 5.7 / 6.1 (12.4 KiB); state 5.9 / 46 (10.4 KiB); municipality 4.1 / 44.5; institution (BCV) 6.1 / 46.8; PDVSA 2.2 / 2.8; facility 1.6 / 3.4; outlet 2.8 / 43.3; state timeline (default kinds, now an explicit source list) 2.5 / 2.6 (14.5 KiB); on-request kinds 0.7–1.1. The p95s are the 10 s feed-health cache refreshing, as before |
| 2026-09-29 | Rules v5 (names in titles only, parish rule, dates), copy of the ui-entities archive (265,352 observations) | full relink 40,140 links in 1.4 s (text links 8,011 → 7,515; `text-name` 564); headline linking alone 11,720 headlines in 1.2 s (was 2.0 s: the summary is no longer searched for names) |
| 2026-09-28 | Entity data files (server-only; the client imports none) | parishes.geo.json 675 KB (157 KB gz), infrastructure.json 444 KB (85 KB gz), population.json 323 KB (89 KB gz); client first load unchanged at 84.4 KiB gz |

## Binary

| Date | Target | Size | Build |
|---|---|---|---|
| 2026-09-24 | linux-x64 (web client embedded) | 78.8 MB | 94 ms compile; runs from any directory, serves every asset |
| 2026-09-24 | linux-x64, trim branch | 87.6 MB | 117 ms compile; all 36 JS/CSS files (entry and on-demand chunks) and the stamped sw.js served from the embedded bundle (run from /tmp, each 200); `scripts/offline.ts` passes against it |
| 2026-09-25 | Docker image (that executable on debian:stable-slim) | 71.3 MB compressed, 250 MB unpacked | 10 s build with cached layers; 83–86 MiB RSS serving the snapshot |

## Crowd reports: proof of work and server cost (2026-09-28, branch crowd)

`taskset -c 8 bun scripts/crowd-pow.ts` (one core of this desktop), and `BUN_JSC_useJIT=0` for the interpreter only:

| What | Measured |
|---|---|
| The page's solver (`src/crowd/pow-solve.ts`), JIT | 1,218,534 hashes/s |
| Same, baseline JIT only (`BUN_JSC_useDFGJIT=0`) | 135,682 hashes/s |
| Same, interpreter only (`BUN_JSC_useJIT=0`) | 30,481 hashes/s |
| Public, 18 bits, 200 real solves | median 0.141 s, p90 0.425 s, p99 0.920 s, mean 0.189 s |
| Public under load, 20 bits (from the rate) | 0.86 s on average |
| Local, 12 bits, 200 real solves | median 0.002 s, p99 0.013 s |
| Interpreter only (from the rate): 18 / 20 / 12 bits | 8.6 s / 34.4 s / 0.13 s on average |
| Native SHA-256, `node:crypto`, one call per attempt | 1,819,750 hashes/s |
| Native SHA-256, `openssl speed -bytes 128 -evp sha256` | 939 MB/s ≈ 7.3 M hashes/s of 128-byte messages |

- **Slow phone:** at the 4× CPU profile of the page measurements above, 18 bits is about 0.8 s on average and 1.7 s
  at p90 (6×: 1.1 s and 2.6 s). These are the desktop numbers scaled, not a phone measurement. With the JIT off (iOS
  Lockdown Mode) a phone would take tens of seconds: the page should start solving when the question opens, in a Web
  Worker, and show progress.
- **Attacker:** ≈ 35 ms of one core per report with native code (≈ 30 reports a second per core), much less on a GPU:
  a small price per report, no wall against someone with many addresses. The rate limits, per-answer ceilings, the
  minimum of connections and the join-only incident rule carry the defence (SECURITY.md, "Crowd reports").
- **Server:** a submission with four answers, SQLite on disk, 2,000 in a row: p50 0.08 ms, p99 1.8 ms. Publishing
  1,436 aggregates (every municipality active): 25 ms. The panel over them: 112 ms (cached until the next publish).

## The report sheet and the room's pictures (2026-09-29, branch ui-signals)

| What | Measured |
|---|---|
| Proof of work in headless Chromium, the built same-origin worker (`scripts/qa/crowd-pow.ts`, 100 solves each) | 12 bits: median 2 ms, p90 7; 18 bits: median 59 ms, mean 83, p90 175, max 477; 20 bits: median 313 ms, p90 888, max 1,944; 2.8 M hashes/s |
| Same with Chromium's CPU throttle at 4× | the same times: the throttle does not reach workers, so a slow phone is estimated from the rate (a quarter of it: 18 bits ≈ 0.4 s mean) |
| Report flow on the local copy (`scripts/qa/crowd-flow.ts`) | the work done before the first tap (30 ms at 12 bits); three requests: `/api/crowd`, one challenge, one report |
| Report sheet chunk + worker + municipality index | sheet ≈ 9 KiB gz, worker 1.6, names index 8 (all on first open) |
| TV wall pictures (desk only; phones load none) | ≈ 20–30 KB per visible card, lazy; about 40 cards re-fetched each 30-min round while the wall is open |
| Camera stills | 480 px JPEGs, 25–60 KB; the map strip loads the 5 current ones; a camera page the 6 h film (≈ 18) lazily |

## TV stills and public cameras (2026-09-29, branch visual)

Measured on this desktop (cores 8–15, `nice 10`), from outside Venezuela, the project User-Agent, hosts paced.

| What | Measured |
|---|---|
| TV stills round, first after a start (128 KB reads) | 38/68 stills, 5.7 MB read, 43 s wall |
| TV stills rounds with learned read sizes (three in a row) | 37–38 stills, 4.0–4.4 MB read (median 74 KB, largest 0.5 MB per channel), 38–40 s wall |
| TV stills CPU per round | ffmpeg decode + JPEG encode 1.5–1.6 s (one process at a time, ~30–50 ms per keyframe, 1080p the slowest); Bun 0.65 s |
| TV still size | 480 × 270 JPEG q72: median 20 KB, largest 31 KB (a day ≈ 45 MB for 38 channels) |
| Keyframe position in the newest segment (38 TS streams) | ends 6–160 KB in (segments 0.4–8 MB); 4 streams split the IDR over several 64 KB PES packets |
| Pure-TS keyframe demux | < 1 ms per segment prefix |
| Channel logos, first run (70) | 64 stored, 1.4 MB of PNG; later runs: logos.json 304, nothing downloaded |
| YouTube live thumbnail | ~31 KB per live channel per check (sddefault_live) |
| Public cameras round (5 stills) | 2.3 MB read (four 525–675 KB JPEGs at 1600 × 1200, one 55 KB), 0.67 s CPU (pure-JS JPEG decode ≈ 120 ms per 1600 × 1200 frame) |
| Public cameras per day | ≈ 118 MB (Charallave west/east every 20 min, north/south hourly, Bonaire every 10 min) |
| Blob store listing, 3,600 stills | cold 17 ms (reads every metadata file); in-memory after the first read: < 0.01 ms; 3,600 puts 2.6 s |
| `cameras` panel over 15 days of stills (5,045 rows) | 58 ms the first time (point-in-polygon, JIT), 7 ms after |
| `/api/v1/stills` view at a moment 3 days back | 6–7 ms |

## Daily download per feed, and the data saver (2026-09-29, branch data-saver)

What each feed downloads in a day at its default interval, measured from this desktop (outside Venezuela, project
User-Agent, hosts paced, no keys, ffmpeg present) with `bun scripts/bandwidth.ts`: one run of every feed on by
default through the scheduler's new byte meter (`RequestOptions.onWire`: response headers plus bodies as the
connection carried them, compressed; TLS and TCP overhead not counted), × runs a day (24 h / interval), × the share
of runs that downloaded a body at all in an archive's run history (the ui-signals copy, 63,354 runs; a run answered
"not modified" records 0 bytes). Two corrections, each said in the row:

- **Second run** (`--twice`): feeds whose first run in a process does extra work once (read sizes learned per
  stream, Kalshi's daily discovery, logos not yet stored) count their second run × runs a day, plus the first run's
  extra once a day.
- **Steady state**: feeds whose single run is a catch-up (a loop, a window or a backlog fetched at once) take the
  steady-state figure measured by their own branch, cited.

The running instance on this machine could not be read for this: `/api/health` and `/api/meta` carry no byte counts,
and before this branch `runs.bytes` held the size of the bodies an adapter *returned* (decoded, base64 for images),
not what it downloaded: 19 KB a round for the TV stills that download 5 MB. From 0.2.0 every run records `wire`
(what it downloaded), and the guide shows what the machine actually downloaded in the last 24 h next to the estimate.

**Heavy = 20 MB a day or more** (`HEAVY_MB_PER_DAY`, src/core/bandwidth.ts). The threshold sits in a gap of the
distribution: the lightest heavy feed downloads 31.3 MB a day, the heaviest light one 15.6. Bold rows are heavy.

| Feed | KB a run | Runs a day | Runs that download | MB a day | Basis |
|---|---:|---:|---:|---:|---|
| **`tv-stills`** | 5008 | 48 |  | **236.0** | second run in a process (first 6283 KB; its extra counted once a day) |
| **`goes-nsa`** | 45738 | 144 |  | **185.0** | steady state, goes-nsa/frame.ts: one 1800-px frame every 10 min (DECISIONS 2026-09-24); a first run fetches the whole loop |
| **`youtube-live`** | 3935 | 48 |  | **184.5** | second run in a process (first 3917 KB; its extra counted once a day) |
| **`public-cams`** | 2861 | 144 |  | **118.0** | steady state, PERF 2026-09-29 (visual): each camera on its own 10–60 min schedule; a first run fetches every camera at once |
| **`goes-glm`** | 2709 | 96 |  | **100.0** | steady state, LOG 2026-09-28 (sources-data): ≈24 KB of range reads per 20-s file, 45 files every 15 min; a first run reads two windows |
| **`iptv-ve-probe`** | 674 | 48 |  | **33.7** | second run in a process (first 2861 KB; its extra counted once a day) |
| **`firms-fires`** | 1346 | 24 | 100 % | **31.5** | one run |
| **`radio-browser-probe`** | 1325 | 24 |  | **31.3** | second run in a process (first 1546 KB; its extra counted once a day) |
| `radio-streams` | 111 | 144 |  | 15.6 | second run in a process (first 111 KB; its extra counted once a day) |
| `gdelt-ve` | 1047 | 96 |  | 12.0 | steady state, gdelt-ve/index.ts, measured over 24 h: 11.7 MB of zips a day (≈60 KB per 15-min file, two streams) plus two lastupdate files a run; a first run backfills 8 batches a stream |
| `ioda-states` | 70 | 144 | 100 % | 9.9 | one run |
| `firms-flares` | 6246 | 1 | 100 % | 6.1 | one run |
| `rnv` | 44 | 144 | 98 % | 6.0 | one run |
| `primicia` | 94 | 144 | 45 % | 5.9 | one run |
| `infobae-venezuela` | 228 | 24 | 100 % | 5.3 | one run |
| `la-prensa-de-monagas` | 51 | 144 | 66 % | 4.7 | one run |
| `iptv-ve` | 2208 | 2 |  | 4.3 | one run |
| `atlantic-council` | 176 | 24 | 100 % | 4.1 | one run |
| `tv-logos` | 1 | 4 |  | 3.9 | second run in a process (first 4017 KB; its extra counted once a day) |
| `el-heraldo-co` | 164 | 24 | 100 % | 3.8 | one run |
| `abc-es` | 50 | 72 | 100 % | 3.5 | one run |
| `el-comercio-pe-mundo` | 147 | 24 | 100 % | 3.5 | one run |
| `ioda-asn` | 25 | 144 | 100 % | 3.5 | one run |
| `polymarket` | 128 | 24 |  | 3.0 | one run |
| `caracol-radio` | 127 | 24 | 100 % | 3.0 | one run |
| `radio-mundial` | 39 | 72 | 100 % | 2.7 | one run |
| `nhc-storms` | 29 | 96 | 100 % | 2.7 | one run |
| `gn-ntn24` | 57 | 48 |  | 2.7 | one run |
| `g1-mundo` | 159 | 24 | 70 % | 2.6 | one run |
| `ofac-sdn` | 7621 | 12 |  | 2.5 | steady state, 12 runs × the publication history (≈7 KB) + 0.36 publications a day in 2026 (97 by 09-28) × the 5.7 MB SDN.CSV, 0.75 MB Wikidata query and delta; a first run fetches the snapshot |
| `semafor` | 257 | 24 | 40 % | 2.4 | one run |
| `occrp` | 102 | 24 | 100 % | 2.4 | one run |
| `abc-color-py` | 97 | 24 | 100 % | 2.3 | one run |
| `impacto-ve` | 31 | 72 | 100 % | 2.2 | one run |
| `elpais-america` | 31 | 72 | 100 % | 2.1 | one run |
| `euronews-es` | 35 | 144 | 43 % | 2.1 | one run |
| `diario-libre-mundo` | 90 | 24 | 100 % | 2.1 | one run |
| `eldiario-es-internacional` | 90 | 24 | 100 % | 2.1 | one run |
| `kalshi` | 52 | 24 |  | 2.0 | second run in a process (first 911 KB; its extra counted once a day) |
| `vtv` | 14 | 144 | 100 % | 2.0 | one run |
| `tg-vtv` | 21 | 96 | 100 % | 2.0 | one run |
| `la-verdad` | 70 | 144 | 20 % | 2.0 | one run |

34 more feeds download 1–2 MB a day (44.7 together) and 248 under 1 MB each (73.3 together). Not measured (28,
counted as "sin medición"): 18 behind a bot wall that answered 415, 202 or an HTML page, 3 that answered 404 or 444,
4 that need a key (`cloudflare-radar`, `dahiti-guri`, `gfw-vessels`, `windy-webcams`), and the 3 opt-in feeds.

| Configuration (defaults, no keys) | MB a day |
|---|---:|
| Everything on, ffmpeg present | ≈ 1,175 (1.1 GiB) |
| Everything on, no ffmpeg (no TV stills downloaded) | ≈ 939 |
| Data saver on (8 heavy feeds off) | ≈ 255 |
| With the free FIRMS key, data saver off | ≈ 1,144 (fires query Venezuela only; not measured with the key, tens of KB an hour) |

What the measurement found:

- **Byte counts that ignored what the connection carried were low: 5×, 23× on a first run.** A probe that asks for the first
  2 KB of a segment receives whole TCP/TLS records (tens of KB) before it can stop: `iptv-ve-probe`'s 123 KB a round
  (SOURCES) is 674 KB measured (2.9 MB on a first run), 33.7 MB a day instead of ~6. The TV stills' "4–6 MB a round"
  is 5.0 MB measured with learned sizes, 236 MB a day. YouTube's live check, 184 MB a day, matches its note (~150).
- **The heavy set** (8): `tv-stills` 236, `goes-nsa` 185, `youtube-live` 184, `public-cams` 118, `goes-glm` 100,
  `iptv-ve-probe` 34, `firms-fires` 32 (without its free key), `radio-browser-probe` 31. Without ffmpeg the TV stills
  download nothing and are not heavy; with the FIRMS key, fires are not heavy. Both are decided again on every
  scheduler tick.
- 324 of 352 feeds measured; 1 run each (plus 9 feeds twice); 139 MB downloaded by the measurement itself (107 MB the full pass, 32 MB the nine feeds run twice).

The first-run question and its sections: the question loads with the Personalizar chunk (it already had to be
fetched to change a setting), so the first load grows by the one check that opens it: **92,163 → 92,203 B gz
(90.0 KiB printed)**, after moving `safeHref` (used only by the alerts tab and the toasts) out of the first load.
The data-saver chunk (the question, the section, the ffmpeg item and their CSS) is on demand. axe: 0 violations on
128 checks (32 pages, the question itself and Personalizar › Mis fuentes included, × dark/light × desk/phone).

## How to add a row

Measure before and after your change on the same profile and the same stored data (`vigia --no-fetch` serves a
snapshot without querying sources), and add one row with the date, the change, and the measured numbers. Rows are
never edited afterwards; a later measurement is a new row.
Per-panel JSON, gzip (live, 2026-09-24): news 32.2 KB, connectivity 11.6, censorship 9.9, quakes 3.8, nightlights 3.3,
weather 2.7, money 2.6, fires 1.7, satellite 1.3, hazards 1.2, oil 0.8.

## API: `/api/history/connectivity` (review 3 H9)

48 days of IODA bins synthesised from the snapshot (the review 3 test set), one core
(`taskset -c 8-15`), fixed `now`. "Stall" is the longest gap seen by a 2 ms timer while the request ran.

| Request | Before: cold | Before: warm | After: cold (stall) | After: warm, new process (stall) |
|---|---|---|---|---|
| 48 h, 1 h steps | 1,055 ms, all blocking | 195 ms, blocking | 802 ms (43 ms) | 102 ms (43 ms) |
| 7 d, 6 h steps | 3,543 ms, all blocking | 255 ms, blocking | 2,281 ms (42 ms) | 92 ms (42 ms) |
| 31 d, 1 d steps | 13,709 ms, all blocking | 627 ms, blocking | 10,294 ms (47 ms) | 111 ms (22 ms) |

After: closed hours persist in `history_levels` (dropped when a bin they read is inserted, revised or pruned), so a
warm request evaluates only the hour in progress (25 state-hours). The background warm-up of 31 days from empty took
12.8 s of wall time (18,625 state-hours) in 20 ms slices; one stall of 156 ms was seen there, from a SQLite WAL
checkpoint that the commit crossing the threshold pays (any writer pays it; archive writes are batched to 400 rows so
the replay itself does not trigger one per slice). A cold 31-day request (10.3 s here) fits the 20 s request budget; past it the answer is a 503 with Retry-After and the finished hours are kept.

## Sources atlas (/fuentes), 2026-09-25

- First load unchanged (107.1 → 106.8 KiB gz): the atlas stylesheet travels as text inside the lazy chunk
  (`ui/atlas/style.ts`). On demand: /fuentes 8.5 KiB + shared atlas chunk (also used by /estado) 9.0 KiB gz.
- `/api/meta` with the atlas fields: 105 feeds 7.7 → 8.9 KB gz. At 1,200 feeds (real meta cloned) `/api/meta` is
  110.8 KB gz and `/api/health` 12.4 KB gz; most of meta is the repeated licence objects, not the atlas fields
  (a licence table referenced by id would cut it; not done, it changes the client contract of every panel).
- 1,200 feeds, CPU throttled 6× (Playwright + CDP): page ready 538 ms (phone) / 600 ms
  (desktop) after navigation on localhost; the virtualised catalogue keeps 32 rows in the DOM; search keystroke to
  paint 29–64 ms; 3 s of continuous scroll over the catalogue: frame p50 16.7 ms, p95 16.7 ms, max 33 ms.

## Landing page (`site/`, 2026-09-25)

Lighthouse 12.8 against `next start` on localhost (headless Chromium, software GL), Spanish page:

| Profile | Performance | Accessibility | Best practices | SEO | LCP | CLS | TBT |
|---|---|---|---|---|---|---|---|
| Mobile (simulated slow 4G, 4× CPU) | 0.94 | 1.00 | 1.00 | 1.00 | 2.7 s (observed 68 ms) | 0 | 170 ms |
| Mobile, WebGL disabled (the still stays) | 0.96 | | | | 2.8 s | 0 | 20 ms |
| Desktop | 1.00 | 1.00 | 1.00 | 1.00 | 0.6 s | 0 | 0 ms |

- LCP is the hero map's still image (20 KB dark / 32 KB light WebP, high priority). The simulated mobile LCP is
  bound by transfer, not by the WebGL scene (same with WebGL off): the HTML is 38.6 KB gzip, of which the React
  Server Components payload is about half (111 KB of 209 KB raw).
- First load, gzip: HTML 38.6 KB, CSS 8.5 KB, fonts 47 KB (Archivo 28.7, Chivo Mono 18.5), JavaScript 145.7 KB
  for modern browsers (React DOM 71.4, the Next.js App Router runtime 46.9, the page's own client code 12.4, the
  rest 15); the 39 KB polyfill file is `nomodule` and never fetched by them. Lazy, after idle and only on capable
  devices (no reduced motion, no Save-Data, 4+ cores, 4+ GB): the map scene (ogl, earcut and the scene code, 20.8
  KB) and its data (23.4 KB). Motion was tried for reveals and dropped: about 30 KB gzip more on first load for what
  CSS and one observer do.
- Media: the recording is fetched only near the viewport and never with reduced motion or Save-Data: WebM (VP9)
  775 KB, MP4 (H.264) 980 KB, poster 71 KB (1.83 MB for the three). `docs/assets/demo.gif` 5.2 MB at 800 px.
- Phone 390 px: no horizontal overflow (scrollWidth 390, both languages).

### Landing page after the pre-launch review fixes (2026-09-25)

Lighthouse 12.8.2, `next start` on :7763, headless Chromium with software GL, one run each (three repeat runs of
mobile es gave 3.1 s LCP each time). "Before" is the pre-launch review's run at 7fa0d1b.

| Run | Perf | LCP | TBT | TTI | Main thread |
|---|---|---|---|---|---|
| Mobile es, simulated slow 4G, before | 0.90 | 2.6 s | 290 ms | 6.1 s | 7.9 s |
| Mobile es, simulated slow 4G, after | 0.94 | 3.0 s | 20 ms | 3.0 s | 0.9 s |
| Mobile en, simulated, before → after | 0.94 → 0.95 | 2.8 → 2.9 s | 170 → 20 ms | 5.6 → 2.9 s | |
| Mobile es, applied (devtools) throttling, before → after | 0.99 → 0.99 | 1.7 → 1.6 s | 100 → 40 ms | 3.9 → 3.0 s | |
| Desktop es / en, after | 1.00 / 1.00 | 0.7 / 0.6 s | 0 | 0.7 / 0.6 s | |

Accessibility, best practices and SEO are 1.00 in every run.

- The WebGL scene no longer loads on phones (it needs a ≥1024 px screen with a mouse, and the map on screen): the
  main thread drops from 7.9 s to 0.9 s and TBT from 290 to 20 ms. On desktop, the render loop stops once the intro
  is over and the pointer is still: 0 draw calls in 60 idle frames (it drew 30 frames a second before).
- The simulated LCP did not improve (2.6 → 3.0 s) and it is not a real-device number: Lantern's pessimistic estimate
  counts every byte requested before the observed LCP (at 86 ms, unthrottled), about 350 KB here: the async React
  chunks, the fonts, the still and the two below-the-fold stills Chrome fetches early. The applied-throttling run,
  which really loads the page over emulated 4G, is 1.6 s. `content-visibility: auto` on the sections cut style and
  layout from 225 to 119 ms but broke anchor jumps from the menu (#instalar landed 6,000 px off at 390 px) and was
  dropped.
- The LCP still now comes in 640/960/1280 widths per theme, preloaded with `imagesrcset` and a
  `prefers-color-scheme` media query (a 412 px phone at 1.75x gets the 960, 28 KB, instead of 33 KB); Chivo Mono is no
  longer preloaded.
- HTML: 44.3 KB gzip (was 39.5 KB). It grew with content the review asked for (the install steps per system, the
  vertical architecture diagram for phones, the Bolsillo card, light-theme crops, the recording as text); the
  diagrams are styled by class and the code blocks are single strings to hold it there.
- The recording no longer plays by itself on phones, coarse pointers, non-4G connections or Save-Data: 0 bytes of
  video until a tap (was 775 KB WebM on every phone).

### Landing page: sources and changelog pages (2026-09-25)

Lighthouse 12.8.2 (mobile, simulated slow 4G), `next start` on :7765, headless Chromium, one run each:

| Page | Perf | A11y | BP | SEO | LCP | TBT | CLS |
|---|---|---|---|---|---|---|---|
| `/` | 0.96 | 1.00 | 1.00 | 1.00 | 2.8 s | 50 ms | 0 |
| `/fuentes` | 0.99 | 1.00 | 1.00 | 1.00 | 2.1 s | 40 ms | 0 |
| `/cambios` | 0.99 | 1.00 | 1.00 | 1.00 | 2.0 s | 30 ms | 0 |
| `/en` | 0.98 | 1.00 | 1.00 | 1.00 | 2.3 s | 50 ms | 0 |
| `/en/sources` | 0.99 | 1.00 | 1.00 | 1.00 | 2.1 s | 40 ms | 0 |
| `/en/changelog` | 0.98 | 1.00 | 1.00 | 1.00 | 2.5 s | 40 ms | 0 |

- HTML gzip: home 43.9 → 58.6 KB (the Fuentes section: four count-ups, the state map at 7.7 KB of simplified
  outlines, 96 publisher names; each appears twice, in the HTML and the RSC payload). `/fuentes` 53 KB (all 313 rows
  server-rendered; the filter only hides rows and folds each row's text for search on first use), `/cambios` 26 KB.
- The map's outlines are the app's own geometry at a quarter scale, Douglas-Peucker to half a unit, relative
  integer path commands: 55 KB of JSON rings become 7.7 KB of path data.
- Phone 390 px: no horizontal overflow on any of the six pages, dark and light.


### 1.0.0 (2026-09-29, release build, slow-phone profile, a live instance's data)

First visit: FCP 600 ms, data on screen 5,413 ms, 203.9 KiB transferred; repeat visit: FCP 64 ms, data on screen
221 ms, 0 KiB. First load 90.6 KiB gzip (on demand 491.3 KiB).
