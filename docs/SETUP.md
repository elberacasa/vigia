# Setup guide

Vigía is a self-hosted tool: you run it on your own computer, with your own keys if you want any. It works fully
with **no keys and no payment method**; keys only add optional extras.

## 1. Run it

### Option A: a single file (no install)

Download the archive for your system from the releases page, extract it, and run the `vigia` file inside. It needs
no Bun, Node or Docker. The archives are a quarter to a half of the program's size (sizes for 0.1.0):

| System | Download | Size | How to run |
|---|---|---|---|
| Windows (x64) | `vigia-<version>-windows-x64.zip` | 44 MB | right-click → "Extract All", then double-click `vigia.exe` in the extracted folder |
| macOS (Apple silicon) | `vigia-<version>-darwin-arm64.tar.xz` | 20 MB | `tar -xf vigia-<version>-darwin-arm64.tar.xz && ./vigia-<version>-darwin-arm64/vigia` |
| macOS (Intel) | `vigia-<version>-darwin-x64.tar.xz` | 24 MB | `tar -xf vigia-<version>-darwin-x64.tar.xz && ./vigia-<version>-darwin-x64/vigia` |
| Linux (x64) | `vigia-<version>-linux-x64.tar.xz` | 31 MB | `tar -xf vigia-<version>-linux-x64.tar.xz && ./vigia-<version>-linux-x64/vigia` |
| Linux (ARM64) | `vigia-<version>-linux-arm64.tar.xz` | 29 MB | `tar -xf vigia-<version>-linux-arm64.tar.xz && ./vigia-<version>-linux-arm64/vigia` |

Each archive holds one folder with the program (its executable bit kept), `LICENSE` and `NOTICE`. The same
programs are also published uncompressed (`vigia-<version>-<system>`, 73 to 97 MB; on Linux and macOS run
`chmod +x` on them first) for scripts and servers that prefer a single file.

The files are not signed by Apple or Microsoft yet, so the first run asks for confirmation:

- **macOS** blocks the file the first time ("cannot be opened because the developer cannot be verified"). Open
  System Settings → Privacy & Security and choose "Open Anyway", or run
  `xattr -dr com.apple.quarantine ./vigia-<version>-darwin-*` once.
- **Windows** SmartScreen may show "Windows protected your PC": choose "More info" → "Run anyway". If you start
  it with `--host 0.0.0.0` (for other devices), Windows also asks whether to allow it on the network: "private
  networks" is enough, and denying it only keeps other devices out.

Check the download against `SHA256SUMS`, published with every release:

```sh
sha256sum -c SHA256SUMS --ignore-missing          # Linux
shasum -a 256 -c SHA256SUMS --ignore-missing      # macOS
```

On Windows (PowerShell): `Get-FileHash .\vigia-<version>-windows-x64.zip` and compare with its line in
`SHA256SUMS` (the list covers every archive and every uncompressed program).
`vigia --version` prints the version you have.

### Option B: from source

Requires [Bun](https://bun.sh) (developed on 1.4).

```sh
git clone https://github.com/elberacasa/vigia.git
cd vigia
bun install
bun run build:web    # build the client into web/dist (once, and after changing web/)
bun start
```

For development with reload: `bun run dev`. To build the single-file executables yourself: `bun run build:bin`
(all five targets into `dist/`, or `bun scripts/build-bin.ts linux-x64` for one).

### First run

Vigía starts a local server and opens `http://localhost:7722` in your browser. With no keys, earthquakes, news,
exchange rates, connectivity, weather and satellite imagery start filling in within a minute or two. The status page
(`/estado`) shows each source's health; the sources page (`/fuentes`) lists who publishes what, under which licence.

## 2. Command line

```
vigia                    start and open http://localhost:7722
vigia --port 8080        use another port
vigia --host 0.0.0.0     let phones and other devices on your network open it (read-only for them)
vigia --no-open          do not open the browser
vigia --no-fetch         serve what is stored without querying any source
vigia sources            list every source and whether it needs a key
vigia fetch <source>     query one source once and print what came back
vigia paths              where settings, keys and data are stored
vigia --version          print the version
vigia verify [file]      check the sealed archive, or an evidence file (see docs/EVIDENCIA.md)
vigia status             print the current situation from a running Vigía (--port, --color, --lang en)
curl localhost:7722      the same situation as plain text
```

## 3. Optional keys

Keys are added in the in-app setup guide (`/guia`), which explains each one, links to the sign-up page, and checks
the key live with a harmless request before saving it. You can also set them as environment variables (the name is
the key id in upper case with underscores), which is convenient for development with a `.env` file.

| Key | Environment variable | Cost | What it adds |
|---|---|---|---|
| NASA FIRMS MAP_KEY | `NASA_FIRMS_MAP_KEY` | free, email only, no card | Fires with far less data downloaded: queries for Venezuela only instead of the whole South America file (~41 MB a day without a key). |
| DAHITI API key | `DAHITI_API_KEY` | free, email only, no card (non-commercial use) | The Guri reservoir level from satellite altimetry, in the Servicios panel. |
| Jev (TypeSafe) | `TYPESAFE_API_KEY` | paid per use (about US$0.00014 per news item) | The most accurate news classification in the AI section: topics, state, blackout reports. |
| Anthropic (Claude) | `ANTHROPIC_API_KEY` | paid per use | A written daily brief in the AI section, with checked citations, only when you ask for it. |

No key is required for any core panel. Paid keys only act within a budget you set in the AI section; with no
budget set, Vigía makes no paid request.

### Free alternatives for the AI section

- **Bundled local model** for news classification: runs offline on any CPU, no key. It is marked experimental,
  with its measured accuracy shown next to it (see [AI.md](AI.md)).
- **Ollama**: a local LLM for the written brief. Install it from ollama.com, pull a model, and pick "Ollama" in the
  AI section. Vigía talks to it at `http://127.0.0.1:11434`.
- **Your own Claude Code**: if the `claude` command is installed and signed in on this machine, Vigía can use it for
  the written brief under your own subscription, with no tools and no access to your files.

### Opt-in sources

A few sources are off until you turn them on in the setup guide (`/guia`), which shows the reason for each:

- **Binance P2P** and **Bybit P2P** quotes: these platforms' terms restrict automated access and the endpoints are
  undocumented. Vigía queries them gently and never stores advertisers' names or ids. Without them, Yadio still
  gives the P2P market rate.
- **Government portal probe**: your computer would visit the home pages of public portals every 15 minutes,
  identifying as Vigía, so their operators would see your IP address. Leave it off if that exposes you.

## 4. Where your data lives

`vigia paths` prints the locations. By default:

| System | Settings and keys | Data (database, images) |
|---|---|---|
| Linux | `$XDG_CONFIG_HOME/vigia` (usually `~/.config/vigia`) | `$XDG_DATA_HOME/vigia` (usually `~/.local/share/vigia`) |
| macOS | `~/Library/Application Support/Vigia` | `~/Library/Application Support/Vigia/data` |
| Windows | `%APPDATA%\Vigia` | `%LOCALAPPDATA%\Vigia` |

Set `VIGIA_HOME` to keep everything in one folder instead (portable mode: settings and keys in it, data in its
`data/` subfolder).

- History is kept from day one. By default nothing is deleted; set `retentionDays` in `config.json` to prune older
  observations (never below 35 days). Pruning rows of an already sealed day makes that day fail `vigia verify`,
  which then reports the missing rows.
- Keys are stored in `keys.json` readable only by your user account (mode 600) where the OS supports it. They are never shown again
  after you enter them, never sent to the browser (only "set / not set"), never logged, and only sent to the service
  they belong to.

## 5. Using it from other devices

`vigia --host 0.0.0.0` lets phones and other computers on your network open Vigía at `http://<your-ip>:7722`.
They can read everything, but settings and keys can only be changed from the machine running Vigía: writes require
a loopback address, a matching origin, and a session cookie that only the browser opened by the command line gets.
If you put Vigía behind a reverse proxy, keep it on a trusted network; see [SECURITY.md](../SECURITY.md).

## 6. Troubleshooting

- **A panel says "stale" or a source is failing**: open `/estado`; each source shows its last success, its error
  and when it will retry. The last good value stays on screen with its real age.
- **Port already in use**: `vigia --port 8080`.
- **A key is rejected**: the guide shows the provider's answer; check the key was copied whole.
- **Starting over**: stop Vigía and delete the folders shown by `vigia paths`.
