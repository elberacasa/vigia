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

## Supported versions

Only the latest release and the `main` branch receive security fixes while the project is at 0.x.

## Scope

In scope:

- The local server (`src/server`): any way to read keys, change settings, spend paid-API budget, or write data
  without being the person at the machine; bypasses of the write guard or session token described below.
- Key handling (`src/config`): keys leaking to logs, to the browser, to a provider other than their own, or to disk
  with loose permissions.
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
