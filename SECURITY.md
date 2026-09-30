# Security policy

Vigía runs on the user's own computer, holds their API keys, and is sometimes exposed to a local network. Security
reports are welcome and taken seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Security" tab → "Report a vulnerability") on this repository.

Include what an attacker can do, the steps or a proof of concept, and the version or commit. You can expect an
acknowledgement within a week and a fix or a plan within 30 days for confirmed issues. Credit is given in the
changelog unless you prefer otherwise.

## Anything else

Questions, ideas and bugs that are not security issues go in public: GitHub
[Discussions](https://github.com/elberacasa/vigia/discussions) or [issues](https://github.com/elberacasa/vigia/issues),
or the maintainer on X, [@elberacasa](https://x.com/elberacasa). Never post a vulnerability there: use the private
report above.

## Supported versions

Only the latest release and the `main` branch receive security fixes while the project is at 0.x.

## Scope

In scope:

- The local server (`src/server`): any way to read keys, change settings, spend paid-API budget, or write data
  without being the person at the machine; bypasses of the write guard or session token described below.
- Key handling (`src/config`): keys leaking to logs, to the browser, to a provider other than their own, or to disk
  with loose permissions.
- Crowd reports (`src/crowd`): anything that stores or leaks who reported (address, device, time finer than the
  published bucket), bypasses the anonymous-write guard, the proof of work or the flood rules, or lets users' reports
  alone make an incident.
- Injection through feed content: a malicious or compromised source injecting script, markup or terminal escape
  sequences into the page, the share images, `/ahora.txt` or `vigia status`.
- Evidence bundles and the sealed archive (`src/intel`): forging a bundle that `vigia verify` accepts, or altering
  sealed history without detection.
- Denial of service that takes the whole page down from one feed or one client (the design says no single feed or
  client can).
- The release binaries and the build scripts.

Out of scope:

- Correctness of third-party data (report a wrong figure as a regular issue: "Feed broken or stale").
- Attacks that need an account on the user's machine, or a user who deliberately exposes Vigía to the internet
  behind a proxy that strips its protections.
- Rate limits and terms of the upstream sources themselves.

## What the protections are

- **Reads are open, writes are local.** Anyone who can reach the server may read the dashboard and the public API.
  Every mutating endpoint (keys, AI settings, the paid brief) requires all of: a loopback client address, a
  loopback `Host` (defeats DNS rebinding), an `Origin` that matches the host, a JSON content type, and the session
  cookie below. With `--host 0.0.0.0`, phones on the network can view Vigía but cannot change anything.
- **Session token.** On first run Vigía creates a random 256-bit token in a `0600` file next to `keys.json`. The
  CLI opens the browser with the token in the URL; the server exchanges it for an `HttpOnly`, `SameSite=Strict`
  cookie and removes it from the address bar. This separates the person at the terminal from anything else on the
  same machine, such as a local reverse proxy that would otherwise pass the loopback and origin checks. Tokens are
  compared in constant time.
- **Keys.** Stored only on the user's machine (`keys.json`, `0600` where the OS supports it) or read from
  environment variables. They are never logged, never sent to the browser (only whether each one is set), and
  only ever sent to the provider they belong to.
- **Paid requests.** Every paid API call goes through one ledgered client with a hard budget the user sets; with no
  budget, no paid request is made.
- **Rate limits** on every endpoint, per client, with tighter limits on writes, history queries and evidence
  bundles, and a cap on open live-update streams per client.
- **No telemetry.** Vigía contacts only the data sources the user enables and, if configured, the AI providers the
  user chose. It never reports usage anywhere.

## Pictures and live checks from other servers (TV stills, logos, public cameras, TV and radio probes)

Vigía turns bytes from servers it does not control into pictures it serves from its own origin. What holds:

- **Only public hosts.** Every stream, logo and camera URL, and every TV and radio liveness probe, and every redirect hop before it is requested, must resolve
  only to public addresses (`src/media/public-host.ts`): a list entry pointing at a LAN camera or router is refused.
  Not covered: a DNS answer that changes between the check and the connection (rebinding).
- **Re-encoded, never passed through.** PNG and JPEG only; sizes checked before decoding (≤ 4 MP, ≤ 4,096 px a side);
  a PNG is reduced to its image chunks and its data inflated under the size its header allows before any decoder sees
  it; every served picture is Vigía's own JPEG or PNG (no metadata, no polyglots, no SVG).
- **ffmpeg (optional) sees one validated H.264 keyframe** on stdin: no container demuxer, no network protocols, one
  frame, one thread, `-max_alloc`, a 10 s kill, an empty working directory, only `PATH` in its environment, lower
  priority, and on Linux `prlimit` (1 GB address space, 10 s CPU, 32 files). It still runs as the Vigía user and can
  read what that user can: operators who want more can run Vigía in a container or set `VIGIA_FFMPEG` to a wrapper
  (bwrap, firejail), or `VIGIA_FFMPEG=0` to turn stills off.

## Crowd reports: the one anonymous write

"¿Tienes luz, agua, internet, gasolina?" (`POST /api/crowd/reports`) is the only write that does not need the session
cookie, because the people who answer (a public mirror's visitors, a household's phones on the LAN) never have it.
It has its own guard instead (`src/crowd/routes.ts`):

- JSON only, an `Origin` naming the `Host` the request was sent to, `Sec-Fetch-Site: same-origin` when sent, a 2 KB
  body cap (declared or chunked). No crowd route sends CORS headers.
- On a personal Vigía: only from loopback, private or link-local addresses, and only to a `Host` that is `localhost`
  or an IP literal (a rebound DNS name is refused). On a public mirror: only from public addresses that are not a
  declared proxy (a private peer means an undeclared proxy; set `VIGIA_TRUST_PROXY`).
- Then per-state load limits (checked before the work is spent), a SHA-256 proof of work (18 bits on a mirror),
  per-connection and per-IPv6-/48 rate limits, a flood ceiling per municipality, service and answer whose excess is
  held and shown as "posible manipulación", a minimum of distinct connections (nothing below it is published), and
  one answer per connection, municipality and service. Every accepted answer reads "received".
  `--no-crowd` / `VIGIA_CROWD=0` turns it off.
- Known limits, stated: behind one carrier NAT address, at most 4 phones count per municipality and service, and
  only phones whose page sends a token; the proof of work is a small price, not
  a wall, against many addresses or a GPU; the 15-minute publication coarsens timing but does not make a report
  unlinkable on a quiet mirror; users' reports never open, promote or name an incident, because they can be faked.
- **Per-device token (optional):** a random value the page makes, so phones behind one carrier address count
  separately (at most 4 per address, municipality and service). Only its HMAC under the daily salt is kept, in
  memory, while its answer lives; it raises no limit (every limit stays on the address and its /48).
- **What is stored:** counts per municipality, service, answer and 15-minute bucket, and the published aggregates.
  Never the IP address, User-Agent, the device token or anything about the device, a cookie, coordinates or the
  exact time of a report. The abuse-control state is in memory only, under an HMAC fingerprint with a random salt replaced daily, and dropped
  when its window ends. A report that would let someone identify a reporter, fake or hide a blackout past these
  rules, or write anything else, is in scope below.
