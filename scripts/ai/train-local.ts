/**
 * Distils Jev's labels into the bundled local model and measures everything against the gold set:
 *   bun scripts/ai/train-local.ts [--final] [--pos 4] [--epochs 20] [--out <model.bin>]
 *   bun scripts/ai/train-local.ts --model src/ai/local/news-model.bin --write-eval
 * Training data: every exported/harvested item labelled by Jev, minus the gold items (held out). Targets are Jev's
 * probabilities (soft labels). Reports the pre-registered marks for keyword rules, Jev and the local model.
 * `--model` skips training and evaluates an existing model file; `--write-eval` writes the raw counts
 * (scripts/ai/evaluation-counts.json) and regenerates src/ai/evaluation.ts from them. The exact command that built
 * the shipped model is in docs/AI.md. Inputs (items, Jev labels, gold labels) are read from $VIGIA_AI_DIR
 * (default `runs/ai`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { features } from "../../src/ai/local/features.ts";
import { type HeadSpec, LinearModel } from "../../src/ai/local/model.ts";
import type { NewsLabels } from "../../src/ai/news-questions.ts";
import { EVENT_TYPES, STATE_OPTIONS, TOPIC_DEFS } from "../../src/ai/news-questions.ts";
import { tagPlaces } from "../../src/news/places.ts";
import { stripDateline } from "../../src/news/text.ts";
import { topics as ruleTopics } from "../../src/news/topics.ts";
import {
	type Confusion,
	type EvaluationCounts,
	LOCAL_MODEL,
	type MethodCounts,
	type Ratio,
	renderEvaluation,
} from "./evaluation-file.ts";

const AI = process.env.VIGIA_AI_DIR ?? "runs/ai";
const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : undefined;
type Item = {
	id: string;
	title: string;
	summary: string;
	region: string;
	baseline?: { topics: string[]; state: string | null };
};
type Gold = {
	id: string;
	about_venezuela: boolean;
	topics: string[];
	event_type: string;
	state: string;
	severity: number;
	blackout: boolean;
};
const jsonl = <T>(p: string): T[] =>
	readFileSync(p, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as T);

const items = new Map<string, Item>();
for (const i of [...jsonl<Item>(`${AI}/items.jsonl`), ...jsonl<Item>(`${AI}/harvest.jsonl`)])
	items.set(i.id, i);
const jev = new Map<string, NewsLabels>();
for (const r of [
	...jsonl<{ id: string; labels: NewsLabels }>(`${AI}/jev.jsonl`),
	...jsonl<{ id: string; labels: NewsLabels }>(`${AI}/jev-harvest.jsonl`),
])
	jev.set(r.id, r.labels);
const gold = jsonl<Gold>(`${AI}/gold.jsonl`);
const split = new Map(
	jsonl<{ id: string; split: string }>(`${AI}/gold-meta.jsonl`).map((m) => [m.id, m.split]),
);
const goldIds = new Set(gold.map((g) => g.id));

const TOPICS = Object.keys(TOPIC_DEFS);
const heads: HeadSpec[] = [
	{ name: "about_venezuela", kind: "sigmoid", classes: ["yes"] },
	{ name: "blackout", kind: "sigmoid", classes: ["yes"] },
	...TOPICS.map((t): HeadSpec => ({ name: `topic_${t}`, kind: "sigmoid", classes: ["yes"] })),
	{ name: "event_type", kind: "softmax", classes: Object.keys(EVENT_TYPES) },
	{ name: "state", kind: "softmax", classes: Object.keys(STATE_OPTIONS) },
	{ name: "severity", kind: "softmax", classes: ["0", "1", "2", "3"] },
];

function target(l: NewsLabels): number[] {
	const t: number[] = [
		l.about_venezuela,
		l.blackout,
		...TOPICS.map((k) => l.topics[k as keyof typeof l.topics] ?? 0),
	];
	for (const c of Object.keys(EVENT_TYPES)) t.push(l.event_type.probabilities[c] ?? 0);
	for (const c of Object.keys(STATE_OPTIONS)) t.push(l.state.probabilities[c] ?? 0);
	// Severity: Jev gives a score (expected level); spread it over the two nearest levels.
	const s = Math.max(0, Math.min(3, Number.isFinite(l.severity.score) ? l.severity.score : 0));
	for (let k = 0; k < 4; k++) t.push(Math.max(0, 1 - Math.abs(s - k)));
	return t;
}

const all = [...jev.entries()].filter(([id]) => !goldIds.has(id) && items.has(id));
// Tuning never looks at the gold set: 10 % of the Jev-labelled data is a validation slice (agreement with Jev).
const valIds = new Set(all.filter(([id]) => Number.parseInt(id.slice(-2), 36) % 10 === 0).map(([id]) => id));
const final = process.argv.includes("--final");
const train = all.filter(([id]) => final || !valIds.has(id));
const val = all.filter(([id]) => valIds.has(id));
console.log(
	`training items: ${train.length} · validation (Jev-labelled): ${val.length} · gold held out: ${goldIds.size}`,
);
const modelPath = process.argv.includes("--model")
	? process.argv[process.argv.indexOf("--model") + 1]
	: undefined;
const X = modelPath ? [] : train.map(([id]) => features(items.get(id) as Item));
const Y = modelPath ? [] : train.map(([, l]) => target(l));

// AdaGrad on soft cross-entropy, all heads jointly.
const model = new LinearModel(heads, new Map());
const width = model.width;
const g2 = new Map<number, Float32Array>();
const arg = (name: string, d: number) =>
	process.argv.includes(name) ? Number(process.argv[process.argv.indexOf(name) + 1]) : d;
const LR = arg("--lr", 0.6);
const L2 = arg("--l2", 1e-6);
const EPOCHS = arg("--epochs", 12);
/** Positive targets of rare yes/no heads count this many times more (blackouts are ~2 % of items). */
const POS_WEIGHT = arg("--pos", 4);
const order = X.map((_, i) => i);
let seed = 42;
const rand = () => {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed / 0x7fffffff;
};
for (let epoch = 0; epoch < (modelPath ? 0 : EPOCHS); epoch++) {
	for (let i = order.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[order[i], order[j]] = [order[j] as number, order[i] as number];
	}
	for (const idx of order) {
		const x = X[idx] as Map<number, number>;
		const y = Y[idx] as number[];
		const pred = model.fromLogits(model.logits(x));
		const grad = new Float32Array(width);
		heads.forEach((h, hi) => {
			const o = model.offsets[hi] ?? 0;
			if (h.kind === "sigmoid") {
				const target = y[o] ?? 0;
				const weight = 1 + (POS_WEIGHT - 1) * target;
				grad[o] = weight * ((pred.yes[h.name] ?? 0) - target);
			} else {
				const d = pred.dist[h.name] ?? {};
				h.classes.forEach((c, k) => {
					grad[o + k] = (d[c] ?? 0) - (y[o + k] ?? 0);
				});
			}
		});
		for (const [bucket, v] of x) {
			let row = model.rows.get(bucket);
			let acc = g2.get(bucket);
			if (!row || !acc) {
				row = new Float32Array(width);
				acc = new Float32Array(width).fill(1e-8);
				model.rows.set(bucket, row);
				g2.set(bucket, acc);
			}
			for (let j = 0; j < width; j++) {
				const g = (grad[j] ?? 0) * v + L2 * (row[j] ?? 0);
				acc[j] = (acc[j] ?? 0) + g * g;
				row[j] = (row[j] ?? 0) - (LR * g) / Math.sqrt(acc[j] ?? 1);
			}
		}
	}
}

// Round-trip through the shipped format so we evaluate exactly what ships (or load the file under --model).
const bytes = modelPath ? new Uint8Array(readFileSync(modelPath)) : model.serialize();
const shipped = LinearModel.deserialize(bytes);
console.log(
	`model: ${modelPath ? `${modelPath} (loaded, not trained)` : `${model.rows.size} buckets trained`}, ${(bytes.length / 1024).toFixed(0)} KB serialized, gzip ${(Bun.gzipSync(bytes).length / 1024).toFixed(0)} KB`,
);
if (out) await Bun.write(out, bytes);

// ---------------------------------------------------------------- validation (agreement with Jev, never gold)
{
	let blTp = 0;
	let blFp = 0;
	let blFn = 0;
	let st = 0;
	let stN = 0;
	let ev = 0;
	for (const [id, l] of val) {
		const p = shipped.predict(items.get(id) as Item);
		const y = l.blackout >= 0.5;
		const yh = (p.yes.blackout ?? 0) >= 0.5;
		if (y && yh) blTp++;
		else if (!y && yh) blFp++;
		else if (y && !yh) blFn++;
		if (/^VE-/.test(l.state.choice)) {
			stN++;
			if (Object.entries(p.dist.state ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] === l.state.choice) st++;
		}
		if (Object.entries(p.dist.event_type ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] === l.event_type.choice)
			ev++;
	}
	console.log(
		`validation vs Jev: blackout P ${(blTp / Math.max(1, blTp + blFp)).toFixed(3)} R ${(blTp / Math.max(1, blTp + blFn)).toFixed(3)} (n+ ${blTp + blFn}) · state ${(st / Math.max(1, stN)).toFixed(3)} (n ${stN}) · event ${(ev / Math.max(1, val.length)).toFixed(3)}`,
	);
}
if (process.argv.includes("--no-gold")) process.exit(0);

// ---------------------------------------------------------------- evaluation
type Pred = { about: number; blackout: number; topics: Set<string>; event: string; state: string };
const argmax = (d: Record<string, number>) => Object.entries(d).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
const fromJev = (l: NewsLabels): Pred => ({
	about: l.about_venezuela,
	blackout: l.blackout,
	topics: new Set(TOPICS.filter((t) => (l.topics[t as keyof typeof l.topics] ?? 0) >= 0.5)),
	event: l.event_type.choice,
	state: l.state.choice,
});
const fromLocal = (i: Item): Pred => {
	const p = shipped.predict(i);
	return {
		about: p.yes.about_venezuela ?? 0,
		blackout: p.yes.blackout ?? 0,
		topics: new Set(TOPICS.filter((t) => (p.yes[`topic_${t}`] ?? 0) >= 0.5)),
		event: argmax(p.dist.event_type ?? {}),
		state: argmax(p.dist.state ?? {}),
	};
};
/**
 * The keyword rules exactly as the app runs them today (src/panels/news.ts): topics over headline + summary, the
 * state from the headline first and the summary only when the headline names none. Not the baseline frozen in
 * items.jsonl at export time, which predates later tagger fixes.
 */
const fromRules = (i: Item): Pred => {
	const text = `${i.title}. ${stripDateline(i.summary)}`;
	const opts = {
		venezuelanOutlet: i.region !== "international",
		...(i.region.startsWith("VE-") ? { homeState: i.region } : {}),
	};
	const head = tagPlaces(i.title, opts);
	const places = head.primaryState ? head : tagPlaces(text, opts);
	const t = ruleTopics(text);
	return {
		about: Number.NaN,
		blackout: t.includes("electricidad") ? 1 : 0,
		topics: new Set(t),
		event: "",
		state: places.primaryState ?? "DESCONOCIDO",
	};
};

function count(predict: (g: Gold) => Pred | null, answers: { about: boolean; event: boolean }): MethodCounts {
	const rows = gold
		.map((g) => ({ g, p: predict(g), random: split.get(g.id) === "random" }))
		.filter((r): r is { g: Gold; p: Pred; random: boolean } => r.p !== null);
	const rnd = rows.filter((r) => r.random);
	const ratio = (xs: typeof rows, f: (r: (typeof rows)[number]) => boolean): Ratio => ({
		k: xs.filter(f).length,
		n: xs.length,
	});
	const confusion = (xs: typeof rows): Confusion => {
		const c = { tp: 0, fp: 0, fn: 0 };
		for (const r of xs) {
			const yhat = r.p.blackout >= 0.5;
			if (r.g.blackout && yhat) c.tp++;
			else if (!r.g.blackout && yhat) c.fp++;
			else if (r.g.blackout && !yhat) c.fn++;
		}
		return c;
	};
	const topics = { tp: 0, fp: 0, fn: 0 };
	for (const r of rnd) {
		for (const t of TOPICS) {
			const y = r.g.topics.includes(t);
			const yhat = r.p.topics.has(t);
			if (y && yhat) topics.tp++;
			else if (!y && yhat) topics.fp++;
			else if (y && !yhat) topics.fn++;
		}
	}
	return {
		about: answers.about ? ratio(rnd, (r) => r.p.about >= 0.5 === r.g.about_venezuela) : null,
		blackoutAll: confusion(rows),
		blackoutRandom: confusion(rnd),
		topics,
		event: answers.event ? ratio(rnd, (r) => r.p.event === r.g.event_type) : null,
		stateSpecific: ratio(
			rows.filter((r) => /^VE-[A-Z]$/.test(r.g.state)),
			(r) => r.p.state === r.g.state,
		),
	};
}

const methods: Record<string, MethodCounts> = {
	rules: count((g) => (items.get(g.id) ? fromRules(items.get(g.id) as Item) : null), {
		about: false,
		event: false,
	}),
	"jev-1.13.0": count((g) => (jev.get(g.id) ? fromJev(jev.get(g.id) as NewsLabels) : null), {
		about: true,
		event: true,
	}),
	[LOCAL_MODEL]: count((g) => (items.get(g.id) ? fromLocal(items.get(g.id) as Item) : null), {
		about: true,
		event: true,
	}),
};
const f3 = (x: number) => x.toFixed(3);
console.log("\nOn the gold set (about, topics, event: random split; blackout, state: all gold items):");
for (const [name, m] of Object.entries(methods)) {
	const b = m.blackoutAll;
	const br = m.blackoutRandom;
	console.log(
		`${name.padEnd(20)} about ${m.about ? f3(m.about.k / m.about.n) : "—"} · blackout P ${f3(b.tp / Math.max(1, b.tp + b.fp))} R ${f3(b.tp / Math.max(1, b.tp + b.fn))} (tp ${b.tp} fp ${b.fp} fn ${b.fn}; random split tp ${br.tp} fp ${br.fp} fn ${br.fn}) · topics µF1 ${f3((2 * m.topics.tp) / Math.max(1, 2 * m.topics.tp + m.topics.fp + m.topics.fn))} · event ${m.event ? f3(m.event.k / m.event.n) : "—"} · state(specific, n=${m.stateSpecific.n}) ${f3(m.stateSpecific.k / Math.max(1, m.stateSpecific.n))}`,
	);
}

if (process.argv.includes("--write-eval")) {
	if (!modelPath) throw new Error("--write-eval evaluates a shipped file: pass --model <path>");
	const root = join(import.meta.dir, "..", "..");
	const data: EvaluationCounts = {
		// The evaluation day in Caracas (the gold set's own calendar).
		date: new Date().toLocaleDateString("sv-SE", { timeZone: "America/Caracas" }),
		goldItems: gold.length,
		randomItems: gold.filter((g) => split.get(g.id) === "random").length,
		command: `bun scripts/ai/train-local.ts --model ${modelPath} --write-eval`,
		methods,
	};
	writeFileSync(join(root, "scripts/ai/evaluation-counts.json"), `${JSON.stringify(data, null, "\t")}\n`);
	writeFileSync(join(root, "src/ai/evaluation.ts"), renderEvaluation(data));
	console.log("wrote scripts/ai/evaluation-counts.json and src/ai/evaluation.ts");
}
