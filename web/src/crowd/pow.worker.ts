/**
 * The crowd report's proof of work, off the page's main thread: a same-origin worker file (the page's CSP allows
 * scripts from itself only, not blob: URLs), built on its own by scripts/build-web.ts. It runs the server's own
 * solver (src/crowd/pow-solve.ts: pure TypeScript SHA-256 with a midstate, tested equal to the native hash), posts
 * its progress every 32,768 attempts and the answer with how long it took. It knows nothing but the challenge.
 */
import { solve } from "../../../src/crowd/pow-solve.ts";

export type PowAsk = { id: number; challenge: string; difficulty: number };
export type PowReply =
	| { id: number; type: "progress"; attempts: number }
	| { id: number; type: "done"; nonce: string; attempts: number; ms: number }
	| { id: number; type: "fail" };

const scope = self as unknown as {
	onmessage: ((e: MessageEvent<PowAsk>) => void) | null;
	postMessage(message: PowReply): void;
};

scope.onmessage = (e) => {
	const { id, challenge, difficulty } = e.data;
	const started = performance.now();
	try {
		const found = solve(challenge, difficulty, {
			progressEvery: 32_768,
			onProgress: (attempts) => scope.postMessage({ id, type: "progress", attempts }),
		});
		scope.postMessage(
			found
				? { id, type: "done", nonce: found.nonce, attempts: found.attempts, ms: performance.now() - started }
				: { id, type: "fail" },
		);
	} catch {
		// A challenge that is not printable ASCII (never from Vigía's server): say it failed, the page fetches another.
		scope.postMessage({ id, type: "fail" });
	}
};
