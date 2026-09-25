# Contributing to Vigía

Thanks for helping. Vigía is a live situation room for Venezuela where every figure is sourced and timestamped.
The bar for a change is simple to state: it is correct, it is honest about what it shows, and a stranger
understands it in ten seconds.

By contributing you agree that your contribution is licensed under the project's licence (PolyForm Noncommercial
1.0.0, see [LICENSE](LICENSE)) and that you have the right to submit it.

## Setup

You need [Bun](https://bun.sh) 1.4 or newer (the exact version is pinned in `package.json` as `packageManager`).

```sh
bun install
bun run hooks          # once: runs `bun run check` before every commit
bun run dev            # server with reload, http://localhost:7722
```

`bun start` runs it without reload. `vigia --no-fetch` (or `bun src/cli.ts --no-fetch`) serves what is already
stored without contacting any source, which is handy for UI work. Data and keys live outside the repository
(`bun src/cli.ts paths`); set `VIGIA_HOME=<dir>` to keep a development instance separate.

## The one command

```sh
bun run check
```

Formats and lints (Biome), type-checks (TypeScript strict with `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`), runs every test, and builds the client. It must be green before every commit; the
git hook and CI run the same command on Linux, macOS and Windows. Tests never touch the network: adapters replay
recorded or synthetic fixtures.

`bun run fmt` fixes formatting. `bun scripts/perf.ts` measures bundle size and API latency (see
[docs/PERF.md](docs/PERF.md)); include before/after numbers when a change affects performance.

## Code standards

- TypeScript strict everywhere. No `any`, no non-null assertions; validate external data at the boundary with Zod.
- **Numbers are code.** Rates, gaps, counts, deltas and aggregates are computed deterministically and tested. An AI
  model may classify, cluster or summarise, always labelled as AI and linked to its sources, never produce a figure.
- **Freshness is part of the value.** Every figure keeps its observed and fetched time; stale data is labelled
  stale, never presented as live.
- User-facing text is Spanish first, with English through `t(es, en)`. Body text at least 13 px; the page must work
  on a cheap phone on a slow connection, in light and dark themes, by keyboard, and with reduced motion.
- No new heavy dependencies without a measured reason. The first-load bundle size is tracked in PERF.md.
- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before a structural change, and
  [docs/ETHICS.md](docs/ETHICS.md) before touching sensitive layers (parallel rates, outages, protests).

## Adding or fixing a source

Follow [docs/ADAPTERS.md](docs/ADAPTERS.md). In short:

- [ ] The source's terms allow the use; the licence is declared with its attribution; `raw: false` if its rows may
      not be redistributed; `optIn` if automated access is unclear.
- [ ] `fetch` goes through `ctx.http` and respects the source's rate limit; `normalise` is pure and validated.
- [ ] Freshness budget set; `observedAt` is the source's own time with its time zone parsed.
- [ ] Fixture tests: a recorded fixture (`bun scripts/record-fixture.ts <id>`), or, when the terms forbid
      redistributing the source's data, a synthetic test with invented values (see "Fixtures" below).
- [ ] Registered in `src/adapters/registry.ts`, then `bun scripts/gen-docs.ts` to update
      [docs/DATA-SOURCES.md](docs/DATA-SOURCES.md), the README summary and [NOTICE](NOTICE).

## Fixtures

- A recorded fixture is committed only if the source's licence allows redistributing it. Public domain, open data,
  CC0 and CC BY sources are fine; "all rights reserved", no-redistribution terms and full-text news feeds are not.
- Recorded tests for sources whose fixtures cannot be shared use `hasFixture` (`src/core/fixtures.ts`) and skip
  when the recording is absent; a synthetic test must cover the same parsing everywhere.
- Synthetic payloads are invented (use `example.org` links and documentation IP ranges), never trimmed copies of
  real responses.
- No fixture may contain personal data: names, handles, emails or locations of private individuals. Trim or
  replace them before committing.

## Secrets and privacy

- Never commit a key, token, `.env` file, `keys.json`, a database, or a local path. `.env.example` lists the
  variables with empty values.
- Keys are read only through the key store (`ctx.key(id)` in adapters). Never log a key, put it in a URL shown to
  users, or send it anywhere but its own provider.
- Screenshots in issues and pull requests must not show keys or personal data.

## Commits and pull requests

- Small, focused commits that pass `bun run check`. Message style: an imperative summary in lower case with the
  area first, e.g. `usgs-quakes: parse depth in km from the new field`, and a body that says what was measured
  (test counts, bundle size, latency, a before/after).
- One topic per pull request. Fill in the template; UI changes include screenshots at 390 px and 1440 px.
- User-visible changes get a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md).
- Report security issues privately (see [SECURITY.md](SECURITY.md)), never in a public issue.

## Questions and contact

Ask in [GitHub Discussions](https://github.com/elberacasa/vigia/discussions) (questions, ideas, "is this source
worth adding?"), open an [issue](https://github.com/elberacasa/vigia/issues) for a bug or a broken feed, or reach the
maintainer on X, [@elberacasa](https://x.com/elberacasa). There is no project email.

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
