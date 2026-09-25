import { expect, test } from "bun:test";

test(".env.example lists every key the app knows, by its environment variable", async () => {
	const { readFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { KEY_SPECS } = await import("./keys.ts");
	const { envVarFor } = await import("../config/keys.ts");
	const example = readFileSync(join(import.meta.dir, "..", "..", ".env.example"), "utf8");
	for (const spec of KEY_SPECS) expect(example).toContain(`${envVarFor(spec.id)}=`);
});
