/**
 * Records a live response for an adapter's tests: `bun scripts/record-fixture.ts <adapter-id> [name]`.
 * Saves the raw bytes under src/adapters/<id>/fixtures/<name>/ and prints what normalise makes of them.
 */
import { join } from "node:path";
import { ADAPTERS } from "../src/adapters/registry.ts";
import { openKeyStore } from "../src/config/keys.ts";
import { resolvePaths } from "../src/config/paths.ts";
import { saveFixture } from "../src/core/fixtures.ts";
import { HttpClient } from "../src/core/http.ts";

const [id, name = new Date().toISOString().slice(0, 10)] = process.argv.slice(2);
const adapter = ADAPTERS.find((a) => a.id === id);
if (!adapter) {
	console.error(`Uso: bun scripts/record-fixture.ts <id>\nFuentes: ${ADAPTERS.map((a) => a.id).join(", ")}`);
	process.exit(1);
}
const keys = openKeyStore(resolvePaths().config);
const raws = await adapter.fetch({
	http: new HttpClient(),
	key: (k) => keys.get(k),
	now: Date.now,
	signal: new AbortController().signal,
});
const dir = join(import.meta.dir, "..", "src", "adapters", adapter.id, "fixtures", name);
saveFixture(dir, raws);
const observations = adapter.normalise(raws);
console.log(`${raws.length} respuesta(s), ${observations.length} observaciones → ${dir}`);
console.log(JSON.stringify(observations.slice(0, 2), null, 2));
