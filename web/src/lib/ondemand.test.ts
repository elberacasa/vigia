import { expect, test } from "bun:test";

test("the client treats exactly the server's on-demand views as on demand (fetched when opened, never cached)", async () => {
	Object.assign(globalThis, { localStorage: { getItem: () => null, setItem() {} } });
	const { PANELS } = await import("../../../src/server/panel-registry.ts");
	const { ON_DEMAND } = await import("./data.ts");
	const server = PANELS.filter((p) => p.onDemand)
		.map((p) => p.id)
		.sort();
	expect([...ON_DEMAND].sort()).toEqual(server);
});
