/**
 * The fast layer's interface: a state plus named typed questions in, typed answers with probabilities out.
 * Mirrors TypeSafe's System One request shape so Jev is a thin adapter; tests use FakeJudge.
 */
export type Criteria = string | Record<string, unknown> | unknown[];

export type Question =
	| {
			readonly type: "noul";
			readonly instructions: Criteria;
			readonly criteria?: { readonly true?: Criteria; readonly false?: Criteria };
	  }
	| {
			readonly type: "choice";
			readonly instructions: Criteria;
			readonly criteria: Readonly<Record<string, Criteria | null>>;
	  }
	| { readonly type: "score"; readonly instructions: Criteria; readonly criteria: readonly Criteria[] };

export type Answer =
	| { readonly type: "noul"; readonly noul: number }
	| {
			readonly type: "choice";
			readonly choice: string;
			readonly probabilities: Readonly<Record<string, number>>;
			readonly confidence: number;
	  }
	| {
			readonly type: "score";
			readonly score: number;
			readonly probabilities: Readonly<Record<string, number>>;
			readonly confidence: number;
	  };

export interface Judgement {
	/** The versioned model that answered, e.g. "jev-1.13.0". */
	readonly model: string;
	readonly answers: Readonly<Record<string, Answer>>;
	readonly cached: boolean;
}

export interface FastJudge {
	readonly id: string;
	evaluate(
		state: unknown,
		questions: Readonly<Record<string, Question>>,
		purpose: string,
	): Promise<Judgement>;
}

/** Deterministic judge for tests: answers from a function of (state, question id). */
export class FakeJudge implements FastJudge {
	readonly id = "fake";
	calls = 0;
	constructor(readonly answer: (state: unknown, id: string, q: Question) => Answer) {}
	async evaluate(state: unknown, questions: Readonly<Record<string, Question>>): Promise<Judgement> {
		this.calls++;
		const answers: Record<string, Answer> = {};
		for (const [id, q] of Object.entries(questions)) answers[id] = this.answer(state, id, q);
		return { model: "fake-1", answers, cached: false };
	}
}
