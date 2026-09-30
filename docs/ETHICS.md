# Ethics and safety

Vigía shows sensitive information about a country under stress: parallel exchange rates, blackouts, internet
censorship, protests. These principles decide how it is shown. They are part of the code review: a change that
breaks one of them is a bug.

## People

- **Events and places, not people.** No names, faces or handles of private individuals on the map or in panels.
  Posts and reports link to the original public post or outlet instead of copying it.
- **No personal data.** Vigía never publishes leaked or hacked data, personal data, or the location of individuals.
  Court notices that newspapers print (edictos, carteles de citación…) name private persons with their identity
  numbers: Vigía never stores them, and strips identity numbers from every headline and summary it keeps.
  Measurements that are tied to homes (for example RIPE Atlas probes, whose coordinates are only lightly fuzzed)
  are reduced to counts per state as soon as they are parsed; the individual position is never stored.
- **Military and government aircraft and vessels: counts only.** Vigía may count flights at an airport or ships in
  a port and shows published airspace notices, but never maps or tracks an individual military or government craft.
- **Public officials acting in office may be named**, as official sources name them: the Official Gazette's
  appointments, sanctions lists and Wikidata's office holders. On OFAC's Venezuela sanctions lists a person is named
  only when OFAC's own title is a Venezuelan public office or Wikidata lists them, unambiguously, as holder of one;
  everyone else is a count, and nothing about them (name, id, birth date, document) is stored. Companies and vessels
  are named as the list names them; aircraft are counted by model.
- **Crowd reports are anonymous.** "¿Tienes luz?" style reports need no account; no IP address or device id is
  stored, and they are aggregated to the municipality before anything is shown.

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
- **Live TV and radio.** Free-to-air channels and stations only, from the broadcaster's own stream or a public
  listing; never a relay of a paid channel. State and government-funded media are labelled, and nothing plays until
  you press play. Automatic transcripts are labelled as such, with the model, and link to the moment quoted.
- **Webcams.** Only cameras their operator publishes; never private or unsecured cameras, never a re-stream by
  someone else, nothing behind a bot challenge. Vigía keeps a still only where the operator's terms allow it, at most
  480 px wide, and computes nothing from it but its time, a hash of its bytes, a coarse visual hash, its mean
  brightness and how much of one fixed region is lit (city lights at night). No face or person detection, no
  counting, no zoom. A camera going dark is a hint that only joins what other sources say, never a finding on its own.
- **TV stills.** One reduced frame of each free-to-air channel every 30 minutes, taken from the broadcaster's public
  stream and served from Vigía's own server, so a card shows what is on air without the viewer's browser contacting
  anyone. Each still shows its time; an old one is never shown as current.

## Honesty

- **Every figure is sourced and timestamped.** Tap any number to see who published it, when it was true, when Vigía
  fetched it, its licence and a link to the original.
- **Stale is labelled stale.** Every source has a freshness budget; when it is missed, the figure keeps its real age
  and a stale badge, and the status page says why.
- **Numbers are code, never a model.** Rates, gaps, counts, baselines and changes are computed deterministically
  and tested. Figures Vigía computes itself (an index, an estimate of people affected) say so and link their method;
  they are never presented as official or measured. Models only classify, cluster and summarise; their output is labelled with the model that produced it
  and linked to its sources, and it lives in a separate, optional section.
- **No fake liveness.** No canned animation, no placeholder data presented as real.

## Sources and licences

- Sources are read politely: at the rate their data changes, cached, with conditional requests, identified with the
  project's User-Agent. Vigía never logs in where it has no account or gets around a paywall or bot challenge, and a
  source is dropped if its operator asks or blocks access. Sources whose terms are unclear are shown with a note on
  the sources page and a switch to turn them off; sources whose terms forbid automated access are off by default.
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
