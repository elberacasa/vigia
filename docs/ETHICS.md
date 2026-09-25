# Ethics and safety

Vigía shows sensitive information about a country under stress: parallel exchange rates, blackouts, internet
censorship, protests. These principles decide how it is shown. They are part of the code review: a change that
breaks one of them is a bug.

## People

- **Events and places, not people.** No names, faces or handles of private individuals on the map or in panels.
  Posts and reports link to the original public post or outlet instead of copying it.
- **No personal data.** Vigía never publishes leaked or hacked data, personal data, or the location of individuals.
  Measurements that are tied to homes (for example RIPE Atlas probes, whose coordinates are only lightly fuzzed)
  are reduced to counts per state as soon as they are parsed; the individual position is never stored.
- **No tracking of aircraft or vessels** of any military or government; the airspace layer shows published
  restrictions and advisories only.

## Sensitive layers

- **Parallel exchange rates.** Quotes are shown with the name of whoever published them ("Binance P2P, median of
  the top N ads, 14:05", "Yadio"), with a link, next to the official rate. The gap between them is computed in code.
  Vigía never publishes a rate of its own.
- **Blackouts and internet outages.** Vigía shows measured signals (network reachability, routing, probes, night
  lights) and attributed reports, and says "signal drop" and "reports", not accusations. Incidents show how many
  independent source families agree; they never invent a probability.
- **Protests and social posts.** Moderated: no calls to violence, and nothing unverified presented as fact.
  Unverified reports are labelled "sin verificar" with their source.
- **Casualty and contested figures.** Each figure is shown with its source, side by side (official, independent),
  never blended into one number.

## Honesty

- **Every figure is sourced and timestamped.** Tap any number to see who published it, when it was true, when Vigía
  fetched it, its licence and a link to the original.
- **Stale is labelled stale.** Every source has a freshness budget; when it is missed, the figure keeps its real age
  and a stale badge, and the status page says why.
- **Numbers are code, never a model.** Rates, gaps, counts, baselines and changes are computed deterministically
  and tested. Models only classify, cluster and summarise; their output is labelled with the model that produced it
  and linked to its sources, and it lives in a separate, optional section.
- **No fake liveness.** No canned animation, no placeholder data presented as real.

## Sources and licences

- Every source's terms and rate limits are respected. Scraped sources are read at a low rate, cached, identified
  with the project's User-Agent, and dropped if their operator asks or blocks access.
- Every source is attributed wherever its data appears, and listed on the sources page (`/fuentes`) and in
  [DATA-SOURCES.md](DATA-SOURCES.md).
- Sources whose terms forbid redistribution are displayed only as derived results with attribution; their raw rows
  are never served by the API or included in evidence bundles.
- Some sources allow non-commercial use only. That is one reason Vigía itself is licensed for non-commercial use
  (see the [README](../README.md)).

## Operators and users

- A running instance never identifies the person who runs it: requests to sources carry only the project's
  User-Agent, with the project's public URL as the contact that source policies ask for.
- **No telemetry.** Vigía does not phone home, has no analytics and no error reporting service. Data and keys stay
  on the machine that runs it, and keys are only ever sent to the service they belong to. The one service run by
  the project's maintainer that Vigía reads, `bcv-api` (a second route to the BCV's public rate), is a plain GET
  of a public endpoint that sends nothing about you; `VIGIA_BCV_API=0` turns it off.
- The design allows running Vigía anywhere, including outside Venezuela, and mirroring it if a site is blocked.
