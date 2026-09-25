# Adapters: adding a source

Every feed in Vigía is an adapter: one directory under `src/adapters/<id>/` implementing the `Adapter` interface
from `src/core/types.ts`. Everything downstream (store, panels, API, UI) only ever sees the typed observations an
adapter produces. The reference implementation is `src/adapters/usgs-quakes/`.

The bar: someone reading the adapter knows exactly what the source is, what it measures, its licence, its quirks,
and what happens when it breaks.

## The contract

```ts
interface Adapter<V extends Json> {
  id: string;                          // stable, kebab-case: "usgs-quakes"
  layer: Layer;                        // "money" | "earth" | "internet" | "news" | "social" | "oil" | "society"
  name: { es: string; en: string };
  provider: string;                    // who publishes the data, e.g. "USGS"
  homepage: string;
  licence: Licence;                    // id, name, url, attribution, commercial, raw?: false
  keys: readonly string[];             // key ids it needs; [] works with no key
  intervalMs: number;                  // how often to poll
  freshness: { fetchMs: number; dataMs: number | null };
  optIn?: { es: string; en: string };  // off by default, with the reason shown in the guide
  blobs?: BlobPolicy;                  // retention for images it stores, if any
  fetch(ctx: FetchContext): Promise<readonly RawResponse[]>;   // network only
  normalise(raw: readonly RawResponse[]): Observation<V>[];    // pure
}
```

Each observation carries:

| Field | Meaning |
|---|---|
| `source` | the adapter id |
| `series` | stable id of the thing observed (`usd-ves`, `quake:<id>`, `state:VE-V:bgp`); same thing, same series forever |
| `sourceUrl` | a page a person can open to check the figure (never an API URL with a key in it) |
| `observedAt` | when the **source** says the value is true (epoch ms) |
| `fetchedAt` | when Vigía received it (epoch ms) |
| `licence` | the licence id |
| `value` | a plain JSON object; units in field names (`depthKm`, `ratePerUsd`) |
| `location?` | `{ lat, lon, state?, place? }`; `state` is ISO 3166-2 (`VE-V`) from `src/geo` |
| `confidence` | 0..1; 1 for instruments and official publications, lower for keyword tagging or provisional data |
| `basis` | `measurement`, `official`, `quote`, `report` or `derived`; shown in the UI next to the figure |

### `fetch(ctx)`

- Network only, and only through `ctx.http.request` (never the global `fetch`). The shared client sets the project
  User-Agent, timeouts, bounded retries with backoff (honouring `Retry-After`), a byte cap, and a per-host pace. Set
  `hostGapMs` to respect the source's published rate limit.
- Keys come from `ctx.key(id)`. If a required key is missing, throw `MissingKeyError`; the feed then shows as
  locked in the setup guide. Prefer sending a key in a header; if the source only accepts a query parameter, keep
  that URL out of `sourceUrl` and out of logs.

### `normalise(raws)`

- **Pure and deterministic**: no network, no clock. Use `raw.fetchedAt` for the fetch time, never `Date.now()`.
- Validate at the boundary with Zod. An invalid envelope throws `SchemaError`: the run fails loudly, the last good
  value stays on screen with its age, and the status page shows why. One malformed item is skipped, not fatal.
- Parse time zones explicitly. Venezuela is UTC−4 with no daylight saving time.

### Licence

Declare the source's terms in `licence` (shared licences live in `src/sources/licences.ts`). The `attribution`
text is shown wherever the data appears. If the terms do not allow passing the source's own rows on, set
`raw: false`: the raw feed endpoints then refuse those rows, evidence bundles withhold their values, and panels
still show what Vigía derives from them. Never add a source whose terms forbid the use Vigía makes of it.

### Freshness

- `intervalMs`: no faster than the source updates and its terms allow.
- `freshness.fetchMs`: a successful fetch older than this makes the feed stale (typically 3–5 × the interval).
- `freshness.dataMs`: the source's newest datum older than this makes the feed stale; `null` for event feeds, where
  silence is normal (no earthquake today is not staleness).

## Step by step

1. **Read the source's terms** and rate limits. Note the licence, whether redistribution is allowed, and whether
   automated access is permitted. Sources with unclear terms for automated access are `optIn`.
2. **Create the directory** `src/adapters/<id>/`:

   ```
   src/adapters/<id>/
     index.ts          export const <camelId>: Adapter<Value>
     index.test.ts     tests (recorded and/or synthetic)
     fixtures/<name>/  recorded raw responses
   ```

3. **Write `index.ts`**: a header comment saying what the source is, what it measures, its quirks (with the date
   they were measured), and its licence; then `fetch` and `normalise`. Use a `type` alias (not an `interface`) for
   the value so it is JSON-assignable.
4. **Register it** in `src/adapters/registry.ts` (the order there is the status page order).
5. **Keys**: if it needs one, add a `KeySpec` (`src/sources/keyspec.ts`) to `src/sources/keys.ts`: what it unlocks,
   cost (`free-no-card` only if you verified that no card is asked for), sign-up link, steps, and a harmless
   `validate` call. The setup guide is generated from this list.
6. **Record a fixture**: `bun scripts/record-fixture.ts <id> [name]` saves the live response byte for byte under
   `fixtures/<name>/` with a manifest, and prints what `normalise` makes of it.
7. **Test** (below), then use it from a panel in `src/panels/` if it feeds one.
8. **List the source**: regenerate [DATA-SOURCES.md](DATA-SOURCES.md) as described in
   [CONTRIBUTING.md](../CONTRIBUTING.md); `bun run check` fails when it is out of date.
9. Run `bun run check`.

## Tests

Every adapter has tests that replay responses through `normalise`:

- Counts and a few exact values, time zones, `source === id` on every observation, `observedAt <= fetchedAt`
  (allowing documented skew), and a valid `sourceUrl`.
- One malformed item is skipped; a malformed envelope throws `SchemaError`.
- Every edge case found while researching the source (encodings, empty results, `202` with an empty body, clock
  skew) has its own test.

### Recorded and synthetic fixtures

Recorded fixtures are the real bytes a source sent, so tests replay exactly what production sees. They are only
committed when the source's licence allows redistributing them. For sources whose terms do not (for example
"all rights reserved" data, no-redistribution terms, full-text news feeds, or responses that contain personal
data), the recorded fixtures are kept out of the public repository: the tests that replay them skip when the
fixture is absent, and a **synthetic test** with a small hand-written payload in the source's format covers the
same parsing and validation everywhere. If you contribute an adapter for such a source, write the synthetic test
and keep the recording local.

Synthetic payloads must be invented, not trimmed copies of real responses, and must not contain real people's
names, handles or contact details.

## Honesty

- Name what a figure is: "mediana de 20 anuncios de Binance P2P", not "dólar paralelo". A forecast is a forecast,
  not a measurement. Keyword location is labelled "ubicación por palabra clave".
- Contested figures get one series per source, shown side by side, never blended.
- No names, faces or handles of private individuals; measurements tied to homes (for example network probes) are
  reduced to counts per state inside `normalise`. See [ETHICS.md](ETHICS.md).

## Checklist

- [ ] Terms read; licence declared with attribution; `raw: false` if redistribution is not allowed; `optIn` if
      automated access is unclear.
- [ ] `fetch` uses `ctx.http` only, respects the rate limit (`hostGapMs`), never leaks a key.
- [ ] `normalise` is pure, validates with Zod, throws `SchemaError` on a bad envelope, skips bad items.
- [ ] `observedAt` is the source's time with its time zone parsed; `sourceUrl` is human-openable.
- [ ] `basis` and `confidence` are honest.
- [ ] Freshness budget and interval justified in a comment.
- [ ] Registered in `src/adapters/registry.ts`; key spec added if needed.
- [ ] Tests: recorded fixture (if redistributable) and/or synthetic; malformed item and envelope; edge cases.
- [ ] Data-sources list regenerated; `bun run check` green.
