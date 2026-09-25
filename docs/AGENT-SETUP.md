# Set up Vigía with your AI coding agent

If you use a coding agent on your computer (Claude Code, or any other that can run terminal commands), paste the
prompt below into it. It downloads the right release for your system, checks it, runs it and leaves Vigía open,
step by step, asking before anything that needs you.

Two rules the prompt already carries, and that you should keep too: **never paste a key or password into the chat**
(keys go in Vigía's own setup page, `/guia`, on your machine), and **don't share the link `vigia enlace` prints**
(it lets a browser change your settings).

## The prompt (Spanish)

```text
Instala y configura Vigía (https://github.com/elberacasa/vigia) en este equipo, paso a paso, explicándome cada paso
en una línea. Reglas: no me pidas claves ni contraseñas por este chat y no las escribas en ningún archivo; no
compartas ni publiques el enlace que imprime `vigia enlace`; no uses sudo ni cambies nada fuera de la carpeta que
elijas para Vigía; pregúntame antes de cualquier cosa que no esté en esta lista.

1. Detecta mi sistema y arquitectura (Windows x64, macOS arm64 o x64, Linux x64 o arm64).
2. Consulta la última versión en https://api.github.com/repos/elberacasa/vigia/releases/latest y descarga, en una
   carpeta nueva (por ejemplo ~/vigia), el archivo que corresponde (vigia-<versión>-windows-x64.zip,
   vigia-<versión>-darwin-arm64.tar.xz, vigia-<versión>-darwin-x64.tar.xz, vigia-<versión>-linux-x64.tar.xz o
   vigia-<versión>-linux-arm64.tar.xz) y el archivo SHA256SUMS de la misma versión.
3. Verifica la suma: `sha256sum -c SHA256SUMS --ignore-missing` (Linux), `shasum -a 256 -c SHA256SUMS
   --ignore-missing` (macOS) o `Get-FileHash` comparado con su línea en SHA256SUMS (Windows). Si no coincide,
   detente y dímelo; no ejecutes nada.
4. Extrae el archivo. En macOS, quita la cuarentena solo de esa carpeta: `xattr -dr com.apple.quarantine
   ./vigia-<versión>-darwin-*`.
5. Comprueba que corre: `./vigia --version` (en Windows `vigia.exe --version`).
6. Inícialo en segundo plano (o pídeme que lo abra en otra terminal) con `vigia --no-open`, espera a que
   http://localhost:7722/api/health responda y ejecuta `vigia enlace`: abre ese enlace en mi navegador (no lo
   copies en el chat). Así este navegador puede cambiar ajustes.
7. Dime que las claves son opcionales y que, si quiero alguna (NASA FIRMS, DAHITI, Jev, Anthropic), la ponga yo
   mismo en http://localhost:7722/guia, que las verifica antes de guardarlas en este equipo.
8. Si tengo Claude Code instalado (`claude` en el PATH), ofrece ejecutar `vigia ia conectar` para que el resumen
   escrito del día use mi Claude Code; explica que solo se escribe cuando pulso el botón en /ia y que se apaga con
   `vigia ia desconectar`. Si no lo tengo, sáltate este paso.
9. Termina con un resumen: versión instalada, carpeta, cómo abrirlo otra vez (`vigia`), cómo parar (Ctrl+C o
   cerrar la terminal), y `vigia paths` para saber dónde guarda datos y ajustes.
```

## The prompt (English)

```text
Install and set up Vigía (https://github.com/elberacasa/vigia) on this computer, step by step, explaining each step
in one line. Rules: never ask me for keys or passwords in this chat and never write them into any file; never share
or publish the link `vigia enlace` prints; no sudo, and change nothing outside the folder you choose for Vigía; ask
me before anything not on this list.

1. Detect my OS and architecture (Windows x64, macOS arm64 or x64, Linux x64 or arm64).
2. Read the latest release from https://api.github.com/repos/elberacasa/vigia/releases/latest and download, into a
   new folder (for example ~/vigia), the matching archive (vigia-<version>-windows-x64.zip,
   vigia-<version>-darwin-arm64.tar.xz, vigia-<version>-darwin-x64.tar.xz, vigia-<version>-linux-x64.tar.xz or
   vigia-<version>-linux-arm64.tar.xz) and that release's SHA256SUMS.
3. Verify it: `sha256sum -c SHA256SUMS --ignore-missing` (Linux), `shasum -a 256 -c SHA256SUMS --ignore-missing`
   (macOS), or `Get-FileHash` against its line in SHA256SUMS (Windows). If it does not match, stop and tell me; run
   nothing.
4. Extract it. On macOS, remove the quarantine from that folder only:
   `xattr -dr com.apple.quarantine ./vigia-<version>-darwin-*`.
5. Check it runs: `./vigia --version` (`vigia.exe --version` on Windows).
6. Start it in the background (or ask me to start it in another terminal) with `vigia --no-open`, wait until
   http://localhost:7722/api/health answers, then run `vigia enlace` and open that link in my browser (do not paste
   it in the chat). This lets this browser change settings.
7. Tell me keys are optional and that, if I want one (NASA FIRMS, DAHITI, Jev, Anthropic), I add it myself at
   http://localhost:7722/guia, which checks it before saving it on this computer.
8. If I have Claude Code (`claude` on the PATH), offer to run `vigia ia conectar` so my Claude Code writes the daily
   brief; say it only writes when I press the button on /ia and that `vigia ia desconectar` turns it off. Otherwise
   skip this step.
9. Finish with a summary: installed version, folder, how to open it again (`vigia`), how to stop it (Ctrl+C or close
   the terminal), and `vigia paths` for where data and settings live.
```

## What the agent should not do

- Build from source unless you ask (the release is smaller and checked).
- Put Vigía on the internet (`--host 0.0.0.0` only shares it with your local network; public mirrors are covered in
  [OPERATIONS.md](OPERATIONS.md)).
- Turn on the opt-in feeds (Binance and Bybit P2P, the portal probe): their terms or traffic are why they are off.
