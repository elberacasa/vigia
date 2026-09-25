# The AI section ("Capa IA")

Everything a model adds to Vigía lives in one clearly marked section of the app. Each feature is optional, names
the model that produced it, and shows its measured accuracy next to it. The core situation room never depends on
it: every panel works from deterministic code (see [ARCHITECTURE.md](ARCHITECTURE.md)).

Rules that hold for every feature:

- **Models never produce numbers.** Figures come from tested code; a model may only refer to them.
- **Every output is labelled** with the model that wrote it and links to its sources.
- **Measured before shown.** Each feature is scored on a labelled evaluation set, and the numbers are shown in the
  app. A feature that does not beat the core's rules is either not shipped or shipped as "experimental".
- **No payment needed.** Free backends exist for every feature; paid ones are optional, go through one ledger with
  a hard budget you set, and make no request while the budget is 0.

## Backends, cheapest first

| Backend | Cost | Used for |
|---|---|---|
| Bundled local model (`src/ai/local/`) | free, offline, any CPU | news classification |
| Ollama (local LLM at `127.0.0.1:11434`) | free | written brief |
| The user's own Claude Code (`claude -p`) | the user's subscription | written brief |
| Jev (TypeSafe System One), pinned `jev-1.13.0` | paid per request, user's key | news classification |
| Anthropic API (Claude) | paid per request, user's key | written brief |

Interfaces: the fast layer is a `FastJudge` (`src/ai/judge.ts`): a state plus named, typed questions in, typed
answers with probabilities out. It mirrors TypeSafe's System One request shape, so Jev is a thin client
(`src/ai/jev.ts`) and tests use a fake. Written text goes through a `BriefWriter` (`src/ai/brief-writer.ts`). Every
paid request is recorded and checked against the budget by the ledger (`src/ai/ledger.ts`) before it is sent, so a
restart cannot reset spending.

## Feature 1: classifying news items

Questions (`src/ai/news-questions.ts`): about Venezuela (yes/no), 14 topics (yes/no each), event type (10 options),
blackout reported (yes/no), severity (4 levels), state (25 states plus national / several / outside / unknown). One
request per item, never a batch; instructions in English, the item in Spanish.

The results feed the AI section's own view (blackout reports by state, serious events), always labelled. The core
news panel keeps its keyword rules either way.

### The bundled local model

`vigia-local-news-1` is a set of linear heads over hashed text features plus the keyword-rule and gazetteer signals
(`src/ai/local/`), distilled from Jev's probabilities (soft labels). It was trained on 5,361 Jev-labelled Venezuelan
news items (headlines and summaries from the outlet feeds and their archives), none of them in the evaluation set.
The file is 7.9 MB (3.2 MB gzip) and classifies an item in about 73 µs on a CPU. Training and evaluation scripts are
in `scripts/ai/` (they read their data from `$VIGIA_AI_DIR`).

### Evaluation set

400 news items from 2026-09-24: 300 drawn at random (for unbiased accuracy) and 100 enriched with rare topics
(blackouts, water, internet, protests, fires, rain, crime, health) to measure recall on them. Each item was labelled
independently twice from the headline and summary only, and disagreements were adjudicated by a third pass. The
labels were produced by a large language model, not by human annotators, so labelling errors may be correlated
with the models being measured; treat the figures as agreement with a careful model, not as human ground truth.

**Known bias:** the 100 enriched items were chosen using the keyword rules (each already carries a rare topic
according to the rules), so any figure over all 400 is conditional on the rules firing. The random-split figures
below are the unbiased ones.

### Marks, fixed before any label was seen

The local model would be offered as a default only if, on the evaluation set, it reached all of:

| Field | Metric | Mark |
|---|---|---|
| about Venezuela | accuracy (random split) | ≥ 0.90 |
| blackout | precision and recall (all 400) | both ≥ 0.80 |
| topics | micro-F1 (random split) | ≥ 0.75 |
| event type | accuracy (random split) | ≥ 0.70 |
| state | accuracy where the label is a specific state (all 400) | ≥ 0.80 |

### Results (2026-09-24)

| Method | About Venezuela | Blackout P / R | Topics µF1 | Event type | State (specific) |
|---|---|---|---|---|---|
| Keyword rules (core, no AI) | — | 0.880 / 0.957 | 0.577 | — | 0.861 |
| Jev 1.13 | 0.970 | 1.000 / 1.000 (23/23) | 0.838 | 0.783 | 0.944 |
| Local model v1 (text features only) | 0.910 | 1.000 / 0.348 | 0.746 | 0.687 | 0.750 |
| **Local model v2 (shipped, `vigia-local-news-1`)** | **0.893** | **0.955 / 0.913** | **0.776** | **0.690** | **0.833** |

v2's changes were chosen on a validation slice of Jev-labelled data, never on the evaluation set: keyword-rule and
gazetteer signals as unnormalised features, positive weight 4 on rare yes/no questions, 20 epochs.

**Blackout on the random 300 only** (the unbiased estimate; 6 positives, so the intervals are wide):

| Method | Precision (95 % CI) | Recall (95 % CI) |
|---|---|---|
| Keyword rules | 1.000 (0.566–1.000) | 0.833, 5/6 (0.436–0.970) |
| Jev 1.13 | 1.000 (0.610–1.000) | 1.000, 6/6 (0.610–1.000) |
| Local model v2 | 1.000 (0.566–1.000) | 0.833, 5/6 (0.436–0.970) |

Over all 400, the rules' recall (0.957) and the local model's (0.913, which uses rule features) are inflated by
construction: 17 of the 23 positives come from the rule-selected slice, and 22 of the 23 are tagged `electricidad`
by the rules. Even over 400, 21/23 has a 95 % interval of 0.73–0.98, so meeting the blackout mark is not a
statistically strong pass. On what matters most for the map, the local model does not beat the free rules (state
0.833 vs 0.861; blackout recall equal on the random split).

**The evaluation set was reused adaptively.** v1 was scored on it (blackout recall 0.348), and that result is why
v2's changes were looked for. The v2 numbers are therefore not a clean single-use held-out measurement.

**Verdict.** v2 meets 3 of 5 marks (blackout, topics, state) and narrowly misses two (about Venezuela 0.893 < 0.90;
event type 0.690 < 0.70). It ships **off by default, as "experimental"**, with these numbers next to it; the keyword
rules remain the core.

**Cost of Jev (measured 2026-09-24):** 1,145 items, 1,142 requests (3 from cache), 3,741,966 input tokens,
US$0.157, 70.6 s at concurrency 4 (about 0.5 s per request): about US$0.00014 per item.

### Where the numbers in the app come from

`src/ai/evaluation.ts` is generated, never edited by hand:

    bun scripts/ai/train-local.ts --model src/ai/local/news-model.bin --write-eval

evaluates the shipped model file, Jev's stored labels and the keyword rules exactly as the app runs them (headline
first for the state), writes the raw counts to `scripts/ai/evaluation-counts.json`, and renders
`src/ai/evaluation.ts` from them. A test fails if the checked-in file differs from what the counts render to. The
labelled items themselves are not in the repository (they contain third-party headlines); the counts are.

### Next

A fresh held-out set: items sampled after 2026-09-24 (so none were seen while tuning), deduplicated by
near-identical title against the training data (6 of the current evaluation items have a syndicated twin in
training), a random stratum large enough for about 30 blackout positives (at ~2 % prevalence, roughly 1,500 random
items, or an enriched stratum selected independently of both the rules and the model), labelled blind twice with
adjudication, and scored exactly once per shipped model.

## Feature 2: the written brief

The daily brief (`/resumen`) is always built by code: the day's most-covered stories with every outlet that covered
them, and the key figures with their sources. The AI section can add one short written paragraph on request, from
that code-built brief and nothing else (`src/ai/brief-writer.ts`):

- The model writes **no numbers**. It refers to a figure only through a placeholder (`{F1}`…) that code replaces
  with the exact text; digits in any script, number words and "%" are rejected.
- Every clause must cite its sources, and a figure placeholder is only allowed in a clause that cites that figure.
- Headlines are untrusted third-party text: they are sanitised so they cannot forge citations or placeholders.
- An output that breaks any rule is discarded whole; the code-built brief is always there.
- The user's Claude Code runs locked down: no tools, no MCP servers, no user or project settings, no saved
  session, an empty temporary folder, and the untrusted part of the prompt on stdin.

These checks bound what the model can assert (no invented figures, everything attributed); they cannot prove a
summary is fair, and the page says so.

## Candidate features

Built only when they measurably beat the core's rules on labelled data:

- Clustering stories across outlets and languages ("8 outlets report a blackout in Zulia").
- Blackout and protest reports from free text, mapped, with confidence.
- Cross-signal explanations: internet down + night lights dark + reports, as one event card.
- Translation of international coverage to Spanish, and of Spanish coverage to English.
- Questions answered only from stored data, where code computes every number and the model only routes the
  question.
- Summaries of long official texts, with links.
