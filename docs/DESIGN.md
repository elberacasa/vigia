# Design system

Vigía is read for hours by people who need to trust it: journalists on deadline, analysts, a family checking
whether the power cut is only their street. The interface is built like an instrument, not a poster: flat, precise,
dense but calm, every figure with its source and its age. This page is the reference for the client in `web/`;
the tokens themselves live in one file, `web/src/styles/tokens.css`.

## Principles

- **The data speaks, the chrome is quiet.** Neutral blue-grey surfaces separated by 1 px hairlines. No gradients,
  glows, blurs or drop shadows on surfaces; a single shadow only for what floats (menus, dialogs, the palette).
- **One accent.** Blue (`--accent`) is the only interactive colour: links, the open module, the selected place,
  pressed controls. Amber (`--signal`) belongs to the brand, to "live" and to keyboard focus; it never means "bad"
  and never decorates. Status colours (`--ok`, `--warn`, `--alert`) are used only for status, and always next to a
  word or a shape: a triangle for an alert, a diamond for a notice, a ring for information (never colour alone).
- **Honesty is visible.** Every figure carries its source and age; stale is labelled "desactualizado" (never faded
  into illegibility); unverified reports say "sin verificar"; a keyword location says "palabra clave"; a figure that
  belongs to a state says so on a municipality's page.
- **Motion only when data moves** or on the reader's action (a new row, a rolling digit, a zoom). Reduced motion
  removes the movement and keeps the information.
- **Phone first-class, desk dense.** Phones get readable sizes and one calm scrolling page; desks get a workstation.
  Same tokens, two scales.

## Tokens (`web/src/styles/tokens.css`)

| Group | Tokens | Notes |
|---|---|---|
| Surfaces | `--bg` `--surface-0…3` `--line` `--line-strong` | dark `#0a0d12` → `#1c232d`; light `#eceff3` → `#e7ebf0`, panels white |
| Text | `--text` `--text-2` `--text-3` | `--text-3` is the quietest allowed: ≥ 4.5:1 on every surface (axe-checked) |
| Roles | `--accent` `--signal` `--ok` `--warn` `--alert` and `-soft` tints | tints only behind their own colour's text |
| Map | `--map-sea` `--map-land` `--map-border` `--map-neighbour` | per theme |
| Data | `--data-quake` (violet) `--data-heat` (red-orange) `--data-lightning` (cyan) `--data-infra` (steel) `--data-camera` (near-white) | map point series; graded choropleths use the accent; facilities are neutral steel told apart by shape; camera fans neutral. Never amber, never a status colour |
| Type | `--font-ui` (Archivo) `--font-data` (Chivo Mono) | both OFL, self-hosted, 28 + 18 KB woff2 (ASSETS.md) |
| Scale | `--fs-2xs … --fs-3xl` | phone 11/12/13/15/17/22/28/36 px; desk (≥ 1000 px) 10.5/11/12/13/15/20/26/34 px |
| Space | `--s-1 … --s-12` | 4-pt scale; Compacto density tightens it |
| Radii | `--r-sm` 2, `--r-md` 3, `--r-lg` 4, `--r-pill` 3, `--r-panel` 3 | nothing is a pill; dots stay round |
| Frame | `--cmd-h` 44, `--rail-w` 72, `--inspector-w` 360/380/420, `--statusbar-h` 24 | desk only |
| Motion | `--t-fast` 100 ms, `--t` 180 ms, `--t-slow` 360 ms, `--ease-out` | all 0 with reduced motion |

Type roles: uppercase micro-labels (`--fs-2xs`, 650–700 weight, 0.05–0.09 em tracking) name things; 13 px body on
a desk, 15 px on a phone; times, ages, ids and dense figures in Chivo Mono with tabular numerals; large headline
figures in Archivo with tabular lining numerals.

## The desk: a workstation (≥ 1000 px)

```
┌ command bar ─ brand │ module / Lugar: Zulia ✕ │ search / Ctrl K │ feed health │ ● CARACAS 22:04:33 │ EN ◐ ⚙ ┐
├ rail ┬ module canvas ──────────────────────────────────────────────────────────┬ inspector ─────────────┤
│ 1 Sit│ Situación: vital signs strip                                            │ the selection:         │
│ 2 Din│            map of Venezuela · layer stack (docked) · time machine       │ a place's facts, each  │
│ 3 Mer│ other modules: panels in columns that scroll on their own               │ with source and age;   │
│  …   ├──────────────────────────────────┬──────────────────────────────────────┤ or the incidents       │
│ pages│ Prioridad (rules, severity words)│ Registro de eventos (time·kind·place) │                        │
└──────┴──────────────────────────────────┴──────────────────────────────────────┴────────────────────────┘
  status line: ● Conectado · último dato hace 42 s · key hints · version
```

- **Fixed viewport.** `.ws` is a CSS grid of the whole window (`web/src/styles/workstation.css`); the page never
  scrolls, each column does. It is its own chunk (`ui/ws/`), modulepreloaded only for wide screens, so it is not
  in a phone's first load (the service worker caches it later with the other on-demand chunks, for offline use).
- **Modules** (`web/src/lib/modules.ts`): Situación, Dinero, Mercados, Internet, Energía, Tierra y clima, Noticias,
  Oficial, Humanitario, En vivo. A module is only an arrangement of existing panels in columns (optionally weighted,
  `widths`); each has an address (`/dinero`…), a number key (1–9, 0) and a question. Three columns need ≥ 1700 px;
  below, the third joins the second. The reader's arrangement wins: Personalizar's order sorts each column, and a
  panel's ⋯ menu moves it to the neighbouring column of its module (`deskColumn`, `lib/arrange.ts`).
- **Inspector** (right): the selected place (entity view, below), or with nothing selected the incidents and "Lo
  inusual ahora" (the anomaly engine's list) under them. On a wall
  display (density "Pared") it rotates every 45 s among the panels that are not normal. `I` hides it.
- **Bottom strip**: the priority list (the rule-built clauses of `lib/headline.ts`, with a severity word and shape)
  beside the event log (`lib/ticker.ts`: quakes, IODA outages starting and ending, BCV publications, GDACS alerts,
  block-list changes; newest first, a row with a state selects it). `B` folds it. Both are rebuilt on a 15 s tick
  (`tick` in `lib/data.ts`), never on the 1 s clock.
- **Linked selection.** Selecting a state (map, palette, log, incident) sets one signal that travels in the URL
  (`?estado=VE-V`) across modules. The command bar shows it as a scope chip; the inspector describes it; News,
  Earthquakes, Internet, Fires, Incidents and GDELT filter to it and say so with a chip that clears it (their
  national figures stay national, and say that too); each module's header says which of its panels follow the
  selection and which stay national.
- **Keyboard first.** `/` or `Ctrl K` opens the palette (modules, places, panels, layers, commands, sources, each
  with its live figure and age); `1`–`0` modules; `I` inspector; `B` strip; `P` the selected place's page; `L`
  layers; `Q` quakes; `S` share; `V` clean view; `T` theme; `E` language; `?` the list; `Esc` clears. Single-key
  shortcuts can be turned off (WCAG 2.1.4).

## Components

- **Panel chrome** (`ui/Panel.tsx`): on a desk a 36 px one-line header (NAME · question · age badge · ? · ⋯); the
  question hides in columns under 440 px. On a phone the two-line header and the one-line summary rows stay.
- **Age badge**: mono, 20 px, 3 px radius; neutral when current, "Parcial" / "Desactualizado" / "Sin conexión" in
  the state colour with a dot. The band under a header says the same verdict in a sentence.
- **Severity mark** (`panels/Ahora.tsx` `Severity`): ▲ ALERTA, ◆ AVISO, ○ INFO.
- **Vital signs** (`panels/Pulse.tsx`): on a desk an instrument strip of cells separated by hairlines, mono
  figures, a 2 px bottom rule in the state colour when not normal; on a narrow screen a 2-column grid.
- **Event log rows**: time (mono) · kind (word + square) · text · place (accent, selects) · source.
- **Entity view** (`ui/entity/EntityView.tsx`): a dossier, not a form. Header: breadcrumb, kicker (type · id), name,
  status line, then the **key strip** (below); then the **signals table**; then unusual readings, incidents (only when
  there are some), lists, and on a page the timeline, the map inset and the neighbourhood (below, "Entity pages").
- **Key strip** (`KeyStrip`, words in `lib/entity-signals.ts` `keyFacts`): 4–6 cells in one row on a desk (3 or 2
  columns in narrower room, a container query), each a micro-label ("HABITANTES", "SUPERFICIE", "OPERADOR"), a figure
  or a few words in Archivo, and its source in a quiet dotted line ("censo 2011 (INE)", "WorldPop 2026 (modelo) ·
  calculado") that opens the whole provenance and caveat under the strip. A value that names an entity or a site is
  a link; open incidents and unusual readings jump to their list (and focus it) when it has rows. Population is
  always two cells, "Censo 2011" and "Estimación 2026" (WorldPop, model), never one number; the census is marked
  "calculado" only where Vigía sums it (a state, the country). The two live counts are honest about their inputs: open
  incidents count only what the incidents panel counts (corroborated, measured, open; never a watch or the press
  alone), say "del estado Bolívar" when they are the state's and "· 1 terminado" beside them; unusual readings leave
  out a move already taken back ("· 1 ya volvió"); when their inputs are out of date (the incidents panel's feeds,
  the entity's own signals) a zero becomes "—" with "sin datos recientes para juzgar", never a confident 0. The
  country and the networks carry no live counts (incidents are scoped to states). In narrow room the two live cells
  come first, two columns.
- **Signals table** (`SignalTable`, words in `signalWords`): one row per live signal. Columns: SEÑAL (a short name,
  whose it is when an ancestor's, "dato del estado Bolívar", and one quiet line of context), VALOR (right-aligned,
  tabular, a number or a short state word with its tone mark and unit), FRENTE A LO NORMAL (only when a row has a
  baseline comparison the server sends: IODA's lowest signal, a flare's ratio), BASE (a hairline chip: medido,
  pronóstico, reportado, palabra clave, por su nombre, oficial, derivado, cotización; plus a *dashed* "calculado"
  chip for Vigía's own counts; "estado del feed" for Vigía's own "al día / atrasado"), FUENTE (short, only the
  sources whose figure is present; one feed opens its sheet), EDAD ("12 h", "leído 26 min" for counts
  with no time of their own, "sin hora") and "desactualizado". The name opens the row in place: the source's own
  sentence, every part behind the value, the times (dato de, leído), the basis in words, the method, and a link
  said for what it is ("el dato más reciente en su fuente" for a count). A term that ended is never the value ("Sin
  titular registrado", the last holder in the context line); out of date, "en la última hora" becomes "en su última
  hora medida". The explicit table roles stay on in the narrow layout (screen readers drop a table whose cells change
  display); the legend line sits under the entity's own table only. Signals with
  nothing to say now fold into one line, "Sin datos ahora: Internet sin datos suficientes · Luz nocturna nublado,
  28 % despejado", with "mostrar". Below 620 px of room (phones, the inspector) each row is two lines: name and value,
  then the comparison, basis · source and the age on the right (a `tr::after` flex item forces the break). The
  table's classes are its own: a test (`ui/entity/entity-classes.test.ts`) fails when another stylesheet styles
  them (a global `.chip` once made every basis chip 26 px tall).
- **Buttons**: `.icon-btn` (28 px square, no border, hover surface), `.btn` (26 px, hairline, accent on hover),
  phone header tools (36 px squares with a hairline). Targets are ≥ 24 px (WCAG 2.5.8).
- **Figure strip** (`.lm-figs`, `.gd-figs`, `.sx-figs`, `.lx-figs`): cells of micro-label and mono figure; hairlines
  are drawn by each cell (right and below), so a strip that wraps keeps its grid and an empty cell stays empty.
  Labels wrap, never ellipsize.
- **TV wall** (`panels/LiveTv.tsx`): each poster shows the picture the server's card rule chose
  (`src/panels/cardimage.ts`, re-checked on the page's clock by `lib/cameras.ts` `tvPicture`): a frame Vigía took
  ("Cuadro de las 01:42 · hace 12 min"), YouTube's live thumbnail, a fixed cover (desaturated, a dashed rule, its
  label says it is not a frame), the channel's logo letterboxed with "Sin cuadro reciente" and why, or the channel's
  name set large. A still older than 45 min is never the picture: the page falls back to the channel's logo, which
the server sends with every still, saying the frame's time; why there is no frame is always words, never a probe's
code (`src/media/reason-words.ts`). An image that fails to load falls back to the name
  ("la imagen ya no está guardada"), never a broken icon. The overlay (state chip, caption band) carries the dark
  theme's own tokens in either theme, on a solid band (no gradient). Cards with a current frame come first among the
  live ones. A press plays with sound and the audible tile is outlined in the accent; others playing stay muted at
  their lowest quality; four at a time; arrow keys move between posters (one tab stop). Phones keep the text list
  and load no pictures. "En vivo" is amber with its word.
- **Public cameras** (`panels/Cameras.tsx`, En vivo's second column): a card per camera with the still Vigía took
  (only while live and within 2 × its interval + 5 min; else the last one dimmed and grey, "Última imagen: 29 sept,
  01:39 (no es actual)"), its state as a word and a shape (● en vivo in amber, ▲ cámara caída, ◆ imagen congelada,
  ○ sin revisar / solo en el sitio del operador), the view, place and operator, night brightness "calculado por
  Vigía", and a press to watch in the operator's player where the page may frame it (YouTube's cookie-less player,
  Windy's) or a link to the operator's site; one plays at a time, with a line saying whose server the browser now
  talks to. Terms and verification behind a disclosure.
- **"Lo inusual ahora"** (`ui/Anomalies.tsx`): rows of an ops list, never a status colour (rare is not bad): a
  direction arrow in a hairline square, the server's one-line title, "z = −14,2" in mono, the change ("−62,6 % frente
  a lo esperado"; the value against the baseline only when the source allows passing it on), regional items' states
  each with its own figure and start, "revertido por el BCV…" as a neutral outlined tag, the baseline's window,
  "ya es un incidente: …" as an accent link (the row's title dims to text-2), and the provenance line (source ·
  age or "tasa del …" · DERIVADO · "calculado por Vigía" and "regla" opening in place). An empty list says how many
  series were judged and why not the others; never "todo normal".
- **Space and movement panels** (`panels/Space.tsx`, on demand): a lead figure in Archivo, the source's caveat
  always visible under a 2 px quiet rule, small linear bar charts in the neutral data steel (one series, no axis
  labels but the ends; a grey band for what the satellite could not see; a dashed bar for a period still running;
  each bar's words on hover), and ranked rows. Words the contract fixes: "inundación vista por satélite" with "N % sin
  ver" next to every area (never "zona inundada"); natural forest first, "otra vegetación" apart; each methane plume
  with its own estimate ± uncertainty or "sin estimación publicada" (never a total); "detecciones por radar", "sin
  AIS emparejado" (never ships); "vuelos … vistos". A feed behind a free key shows its silhouette and "Desbloquear
  con una clave gratuita", linking to its entry in the guide. On the map, flood cells in the accent (recurring flood
  grey) and plumes as small hollow red-orange triangles, filled when within 3 km of a facility; both on demand.
- **"¿Tienes luz?"** (`ui/crowd/`): a calm entry (a hairline row under Prioridad on a phone, "¿Tienes luz?
  Reportar" in the command bar, "¿Tienes luz aquí? Reportar" on a municipality) opens one sheet: "¿Dónde?" (search
  by municipality, city or state, or "Usar mi ubicación", placed on the device), "¿Qué tienes ahora?" (one
  segmented radio group per service, the chosen answer in the accent, never a status colour: an answer is not a
  measurement), "Enviar reporte" (accent fill), and "Qué guarda Vigía" / "Cómo se cuentan" from `GET /api/crowd`.
  "Recibido" lists what was sent and when it counts. Everything the page shows of reports says "reportes de
  usuarios", its count and age, "sin verificar".
- **Incident cards**: an ops log: state mark and word (◆ EN CURSO, ○ SIN VERIFICAR, □ TERMINADO; the priority list ranks severity), title, strength
  and times in quiet text, a timeline told apart by shape (measured solid, press hollow, context dashed), actions as
  quiet words that take the accent on hover. No coloured rules or badges.
- **Map**: flat land and sea, a real 2° graticule, hatched "no data", the selected state outlined in the accent,
  public cameras as near-white view fans (`--data-camera`, 60° toward their heading: filled when live with a
  picture, an outline when down or frozen, dashed when only at the operator's) with their stills in a strip under
  the map (each camera's still of the replayed moment while the time machine runs), user reports as dashed,
  hatched municipality outlines with a count of answers in a small box (never a measured fill),
  keyboard focus in amber; quakes in `--data-quake`, heat spots and flares in `--data-heat`, lightning cells (GLM, last hour) in
  `--data-lightning`, graded layers
  (headlines, fires) in the accent; a replayed past view is framed in the accent; the pointer's latitude and
  longitude read out at the top right (mouse only); no vignette, no coastline glow.

## Entity pages and the entity model

Every entity of the ontology has a page (`pages/Entity.tsx`, addresses in `lib/entity-route.ts`):

| Type | Address | Example |
|---|---|---|
| country, state, municipality, parish | `/lugar[/<estado>[/<municipio>[/<parroquia>]]]` (the id's segments) | `/lugar/zulia/maracaibo` |
| facility | `/infra/<slug>` | `/infra/guri` |
| ISP, ASN | `/red/<isp>`, `/red/as<n>` | `/red/cantv`, `/red/as8048` |
| institution | `/institucion/<slug>` | `/institucion/bcv` |
| outlet | `/medio/<slug>` | `/medio/el-pitazo` |
| public camera | `/camara/<id>` | `/camara/charallave-oeste` (its card; its timeline is its strip of kept stills) |

The page and the inspector draw one view model, `EntityModel` (`web/src/lib/entity.ts`), from the server's linked
view `/api/v1/entities/{id}` (`lib/entity-api.ts` adapts it; nothing is computed there beyond choosing the figure a
line leads with):

```ts
EntityModel { ref { id, kind, name, path, parent?, sub? }, asOf, status { tone, text }, facts, sections,
              origin: "api" | "panels", crumbs, codes, attributes, point, map { iso, muni }, relations,
              nearby { rule, byKind, items { ref, km, inside } }, childGroups, population { census, worldpop },
              dataset, timeline, rules, backlog }
EntityFact  { key, label, value, unit?, tone, detail?, stale, inherited?, computed?, method?, textValue?,
              prov { source, feeds, url?, observedAt, basis: measured|forecast|keyword|reported|official|derived|quote } }
```

- **Header**: breadcrumb, kicker (type or subtype in words · the ontology id in mono), name, "Ver en la sala" (selects
  it on the map and in the inspector), status line, "dato más reciente", the key strip. A place's status is the
  verdict (green only for a current measured normal); a facility, network, institution or outlet says how many live
  signals it has and how many are out of date, never "sin anomalías". Key facts by type: a place's people (census
  and WorldPop), area, capital (or its parishes, municipalities, states), open incidents, unusual readings; a
  facility's stated capacity, operator (linked), energy source or IATA/ICAO and city; a network's systems, service,
  holder; an institution's or outlet's attachment, reach, site, and the series or feeds Vigía reads from it. The
  record under the map does not repeat what the strip shows.
- **Señales ahora**: the signals table (above). A figure measured at an ancestor says whose it is in its row ("dato
  del estado Zulia") and in the opened row ("esta cifra es la de estado Zulia, no la de este lugar").
- **Lo inusual ahora**: the entity's own unusual readings and its state's (the anomaly list above), only when there
  are some; a municipality's header offers "¿Tienes luz aquí? Reportar", and its "Ahora" includes "Reportes de
  usuarios: luz" facts (count, "reportado", "calculado por Vigía" with the method; the source is said, not a feed).
- **Sections**: incidents (each with "Personas que viven en …" as a labelled estimate with its caveat, never
  "afectados"), headlines (keyword location labelled "palabra clave"), and what the room's own panels add by fixed
  rules (`lib/entity-extras.ts`): OFAC SDN entries with the entity's exact words, general licences that name it,
  Wikidata offices, the BCV's monetary series. Each says its rule.
- **Cronología** (`ui/entity/Timeline.tsx`): ranges 48 h → 1 año, a density strip that is the time slider (a press
  on a bar narrows the list to it), kinds as toggles asked of the server (shapes: measured solid, press and reports
  hollow, context dashed), day headings, older pages on scroll or with the button until the archive runs out; each
  row says how it is linked and where it comes from.
- **Aside**: the map inset (the state, zoomed to the municipality; the entity's point; the facilities the server
  lists inside or near, a press opens their page), the record (relations, dataset attributes in words not already in
  the strip, codes with OSM and RIPE links, point), facilities by kind and the nearest with distance (in the main
  column on a facility's page, where they are the context), children by type, and the entity's own dataset and
  licence. A page without a map (an institution, an outlet, most networks) moves its lists to the aside so the two
  columns balance; incidents stay with the signals. An incident's title opens it in the room's incidents panel (the
  card scrolled to and focused, its folded group opened), as "ya es un incidente" does from "Lo inusual".
- **Phone**: one column, the header and a 2-column key strip, the table's two-line rows, unusual, incidents and lists,
  then the map and the neighbourhood, the timeline last.
- **States**: loading keeps the frame (skeleton); a state or municipality the server cannot give is built from the
  loaded panels and says so; a page opened before offline is this device's copy (the last eight) and says its age;
  an unknown address offers search and the states; an old municipality slug (`autonomo-atures`) redirects.

## The room and the ontology

- **Selection**: a state (`?estado=`) and, finer, an entity (`?entidad=infra.guri`); Esc steps back one at a time
  (entity, picked point, state). The inspector (`ui/entity/EntityInspector.tsx`) shows the finer one; a
  municipality or parish there is outlined on the map, a facility is ringed and named (even with the layer off).
- **What is here**: a press on land asks `/api/v1/locate`; the inspector shows the point, chips for its parish,
  municipality and state (a chip selects), and the facilities within 5 km. A second press inside the selected state
  picks a point instead of clearing it (the sea, Esc and "← Venezuela" clear).
- **Instalaciones** (`map/FacilityLayer.tsx`, under "Encima"): off by default, lazy, groups as switches with their
  shape (Electricidad square, Petróleo y gas hexagon, Puertos y aeropuertos circle, Represas y embalses inverted
  triangle, Salud cross; health off by default: 790 marks), the 230/400/765 kV grid as thin lines. Marks are a
  pointer shortcut; the keyboard path to any facility is the search.
- **Search**: the palette asks `/api/v1/entities?q=` 180 ms after typing (two characters or more) and lists
  parishes, facilities, networks, institutions and outlets with a type badge after the local places; Enter selects
  on a desk (inspector) and opens the page on a phone; Ctrl/⌘+Enter always opens the page.

## Phone (< 1000 px)

One calm page: the header (brand, Caracas clock, search, customise, preferences as three equal 36 px tools), the
priority list, the panels as summary rows that open in place, the map, and the bottom tab bar (Ahora, Mapa,
Dólar, Noticias, Más). A selection (state, entity, pressed point) opens the same entity view after the map. Entity
and other pages keep the tab bar (no tab current; a tab goes back to the room, to its section). The phone scale keeps 15 px body
text and 11 px minimums; nothing from the desk shell is downloaded.

## Checking a change

- `bun scripts/shoot.ts <url> <dir>`: desk 1440×900, wall 1920×1080, mid 1100×760, phone 390×844@2×; `THEME=light`,
  `CLICK=…`, `KEYS=…`. One headless browser at a time on the shared machine.
- `bun scripts/a11y.ts <url>`: axe, WCAG 2.2 AA, 23 pages (entity pages of every type and the room with the
  facilities layer included) × dark/light × desk/phone.
- `bun scripts/perf.ts <url>` (phone) and `PERF_VIEW=desk bun scripts/perf.ts <url>`; an entity page with
  `PERF_WAIT='.entity--page:not(.entity--loading) .sigt'` (`.facts` before the ficha of 2026-09-29); results in PERF.md.
