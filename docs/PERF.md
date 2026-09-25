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

## Binary

| Date | Target | Size | Build |
|---|---|---|---|
| 2026-09-24 | linux-x64 (web client embedded) | 78.8 MB | 94 ms compile; runs from any directory, serves every asset |
| 2026-09-24 | linux-x64, trim branch | 87.6 MB | 117 ms compile; all 36 JS/CSS files (entry and on-demand chunks) and the stamped sw.js served from the embedded bundle (run from /tmp, each 200); `scripts/offline.ts` passes against it |
| 2026-09-25 | Docker image (that executable on debian:stable-slim) | 71.3 MB compressed, 250 MB unpacked | 10 s build with cached layers; 83–86 MiB RSS serving the snapshot |

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
