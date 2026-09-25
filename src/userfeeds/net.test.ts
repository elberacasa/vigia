import { describe, expect, test } from "bun:test";
import { HttpError } from "../core/types.ts";
import { checkFeedUrl, ipv6Hextets, isPublicAddress, type Resolver, resolvePublic, SafeHttp } from "./net.ts";

describe("isPublicAddress", () => {
	test("refuses every private, local and special IPv4 range", () => {
		for (const ip of [
			"0.0.0.0",
			"10.1.2.3",
			"100.64.0.1",
			"100.127.255.254",
			"127.0.0.1",
			"127.9.9.9",
			"169.254.169.254",
			"172.16.0.1",
			"172.31.255.255",
			"192.0.0.8",
			"192.0.2.1",
			"192.88.99.1",
			"192.168.1.1",
			"198.18.0.1",
			"198.19.255.1",
			"198.51.100.7",
			"203.0.113.9",
			"224.0.0.1",
			"239.255.255.250",
			"240.0.0.1",
			"255.255.255.255",
		]) {
			expect([ip, isPublicAddress(ip)]).toEqual([ip, false]);
		}
	});

	test("accepts public IPv4, including the neighbours of private ranges", () => {
		for (const ip of [
			"8.8.8.8",
			"1.1.1.1",
			"172.15.255.255",
			"172.32.0.1",
			"100.63.255.255",
			"100.128.0.1",
		]) {
			expect([ip, isPublicAddress(ip)]).toEqual([ip, true]);
		}
	});

	test("refuses local and special IPv6, and IPv4 hidden inside IPv6", () => {
		for (const ip of [
			"::",
			"::1",
			"::ffff:127.0.0.1",
			"::ffff:7f00:1",
			"::ffff:10.0.0.1",
			"::ffff:169.254.169.254",
			"::127.0.0.1",
			"64:ff9b::a00:1",
			"100::1",
			"fc00::1",
			"fd12:3456::1",
			"fe80::1",
			"fe80::1%eth0",
			"ff02::1",
			"2001::1",
			"2001:db8::1",
			"2002:7f00:1::1",
			"3fff::1",
		]) {
			expect([ip, isPublicAddress(ip)]).toEqual([ip, false]);
		}
	});

	test("accepts global unicast IPv6 and a mapped public IPv4", () => {
		for (const ip of ["2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8"]) {
			expect([ip, isPublicAddress(ip)]).toEqual([ip, true]);
		}
	});

	test("non-addresses are never public", () => {
		for (const ip of ["", "localhost", "1.2.3", "1.2.3.4.5", "256.1.1.1", "::g", "1:2:3:4:5:6:7:8:9"]) {
			expect(isPublicAddress(ip)).toBe(false);
		}
	});

	test("expands IPv6 forms", () => {
		expect(ipv6Hextets("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
		expect(ipv6Hextets("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
		expect(ipv6Hextets("2001:db8::")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
		expect(ipv6Hextets("1::2::3")).toBeNull();
	});
});

describe("checkFeedUrl", () => {
	const reason = (raw: string) => {
		const c = checkFeedUrl(raw);
		return c.ok ? null : c.reason;
	};

	test("accepts ordinary public feed addresses", () => {
		expect(reason("https://www.example.org/feed/")).toBeNull();
		expect(reason("http://example.org:8080/rss.xml")).toBeNull();
		expect(reason("https://8.8.8.8/feed")).toBeNull();
	});

	test("refuses other schemes, credentials and odd ports", () => {
		expect(reason("file:///etc/passwd")).toMatch(/http/);
		expect(reason("gopher://example.org/")).toMatch(/http/);
		expect(reason("ftp://example.org/feed")).toMatch(/http/);
		expect(reason("https://user:pw@example.org/feed")).toMatch(/usuario/);
		expect(reason("http://example.org:22/")).toMatch(/puertos/);
		expect(reason("http://example.org:6379/")).toMatch(/puertos/);
		expect(reason("not a url")).toMatch(/válida/);
	});

	test("refuses local names and private IP literals, in every spelling", () => {
		for (const raw of [
			"http://localhost/feed",
			"http://localhost./feed",
			"http://router/feed",
			"http://printer.local/feed",
			"http://db.internal/feed",
			"http://a.localhost/feed",
			"http://x.home.arpa/",
			"http://127.0.0.1/feed",
			"http://127.1/feed",
			"http://2130706433/feed",
			"http://0x7f000001/feed",
			"http://0177.0.0.1/feed",
			"http://[::1]/feed",
			"http://[::ffff:127.0.0.1]/feed",
			"http://169.254.169.254/latest/meta-data/",
			"http://[fd00::1]/",
			"http://10.0.0.1:8080/",
		]) {
			expect([raw, checkFeedUrl(raw).ok]).toEqual([raw, false]);
		}
	});
});

describe("resolvePublic", () => {
	const dns =
		(map: Record<string, string[]>): Resolver =>
		async (host) => {
			const hit = map[host];
			if (!hit) throw new Error("ENOTFOUND");
			return hit;
		};

	test("returns a public address", async () => {
		expect(await resolvePublic("example.org", dns({ "example.org": ["93.184.215.14"] }))).toBe(
			"93.184.215.14",
		);
	});

	test("refuses a name that resolves inside the network, even alongside a public address", async () => {
		await expect(resolvePublic("evil.example", dns({ "evil.example": ["127.0.0.1"] }))).rejects.toThrow(
			/privada/,
		);
		await expect(
			resolvePublic("mixed.example", dns({ "mixed.example": ["93.184.215.14", "10.0.0.5"] })),
		).rejects.toThrow(/privada/);
		await expect(resolvePublic("v6.example", dns({ "v6.example": ["::ffff:192.168.0.1"] }))).rejects.toThrow(
			/privada/,
		);
	});

	test("a name that does not resolve is a clean error", async () => {
		await expect(resolvePublic("nope.example", dns({}))).rejects.toThrow(/DNS/);
	});
});

describe("SafeHttp", () => {
	type Seen = {
		url: string;
		host: string | null;
		serverName: string | undefined;
		redirect: string | undefined;
	};
	function fake(responses: Response[], seen: Seen[]): typeof fetch {
		let i = 0;
		return (async (input: string | URL | Request, init?: RequestInit & { tls?: { serverName?: string } }) => {
			const headers = new Headers(init?.headers);
			seen.push({
				url: String(input),
				host: headers.get("host"),
				serverName: init?.tls?.serverName,
				redirect: init?.redirect,
			});
			const r = responses[Math.min(i++, responses.length - 1)] as Response;
			return r.clone();
		}) as typeof fetch;
	}
	const resolve: Resolver = async (host) =>
		({
			"feeds.example": ["93.184.215.14"],
			"other.example": ["2606:4700::1"],
			"inside.example": ["10.1.1.1"],
		})[host] ?? [];

	test("connects to the checked address, keeps the name for Host and TLS, never follows redirects blindly", async () => {
		const seen: Seen[] = [];
		const http = new SafeHttp({
			fetchImpl: fake([new Response("<rss/>", { headers: { "content-type": "application/rss+xml" } })], seen),
			resolve,
			hostGapMs: 0,
		});
		const raw = await http.get("https://feeds.example/rss?x=1");
		expect(raw.body).toBe("<rss/>");
		expect(raw.url).toBe("https://feeds.example/rss?x=1");
		expect(seen[0]).toEqual({
			url: "https://93.184.215.14/rss?x=1",
			host: "feeds.example",
			serverName: "feeds.example",
			redirect: "manual",
		});
	});

	test("brackets an IPv6 target", async () => {
		const seen: Seen[] = [];
		const http = new SafeHttp({ fetchImpl: fake([new Response("ok")], seen), resolve, hostGapMs: 0 });
		await http.get("http://other.example/feed");
		expect(seen[0]?.url).toBe("http://[2606:4700::1]/feed");
		expect(seen[0]?.serverName).toBeUndefined();
	});

	test("follows a redirect to another public host after checking it", async () => {
		const seen: Seen[] = [];
		const http = new SafeHttp({
			fetchImpl: fake(
				[
					new Response(null, { status: 301, headers: { location: "http://other.example/new" } }),
					new Response("ok"),
				],
				seen,
			),
			resolve,
			hostGapMs: 0,
		});
		const raw = await http.get("https://feeds.example/old");
		expect(raw.url).toBe("http://other.example/new");
		expect(seen.map((s) => s.host)).toEqual(["feeds.example", "other.example"]);
	});

	test("refuses a redirect into the private network, by name, by literal, or to another scheme", async () => {
		for (const location of [
			"http://127.0.0.1/admin",
			"http://[::1]/",
			"http://inside.example/",
			"http://169.254.169.254/latest/meta-data/",
			"file:///etc/passwd",
			"http://localhost:7722/api/keys",
		]) {
			const seen: Seen[] = [];
			const http = new SafeHttp({
				fetchImpl: fake(
					[new Response(null, { status: 302, headers: { location } }), new Response("secret")],
					seen,
				),
				resolve,
				hostGapMs: 0,
			});
			await expect(http.get("https://feeds.example/feed")).rejects.toBeInstanceOf(HttpError);
			expect([location, seen.length]).toEqual([location, 1]);
		}
	});

	test("stops after three redirects", async () => {
		const seen: Seen[] = [];
		const http = new SafeHttp({
			fetchImpl: fake([new Response(null, { status: 302, headers: { location: "/again" } })], seen),
			resolve,
			hostGapMs: 0,
		});
		await expect(http.get("https://feeds.example/feed")).rejects.toThrow(/redirecciones/);
		expect(seen.length).toBe(4);
	});

	test("caps the body, by header and while streaming", async () => {
		const big = "x".repeat(2_000);
		const declared = new SafeHttp({
			fetchImpl: fake([new Response(big, { headers: { "content-length": "2000" } })], []),
			resolve,
			hostGapMs: 0,
			maxBytes: 1_000,
		});
		await expect(declared.get("https://feeds.example/feed")).rejects.toThrow(/pesa/);
		const streamed = new SafeHttp({
			fetchImpl: fake(
				[
					new Response(
						new ReadableStream({
							start(c) {
								c.enqueue(new TextEncoder().encode(big));
								c.close();
							},
						}),
					),
				],
				[],
			),
			resolve,
			hostGapMs: 0,
			maxBytes: 1_000,
		});
		await expect(streamed.get("https://feeds.example/feed")).rejects.toThrow(/pesa/);
	});

	test("a non-200 answer is an error with its status", async () => {
		const http = new SafeHttp({
			fetchImpl: fake([new Response("no", { status: 403 })], []),
			resolve,
			hostGapMs: 0,
		});
		await expect(http.get("https://feeds.example/feed")).rejects.toThrow(/403/);
	});

	test("paces requests to the same host", async () => {
		let t = 1_000_000;
		const http = new SafeHttp({
			fetchImpl: fake([new Response("ok")], []),
			resolve,
			hostGapMs: 30,
			now: () => t,
		});
		await http.get("https://feeds.example/a");
		const started = performance.now();
		await http.get("https://feeds.example/b");
		expect(performance.now() - started).toBeGreaterThanOrEqual(25);
		t += 1;
	});
});
