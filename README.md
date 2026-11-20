# pi-moejs

Run JavaScript tool calls in [Pi](https://github.com/earendil-works/pi) with [MoeJS](https://github.com/MoeForge/moejs). The extension **replaces Pi's built-in `codemode` tool**. The model calls `codemode`, and scripts run in MoeJS instead of QuickJS. There is no `moe_codemode` alias or fallback to QuickJS. Pi's host process and other tools are unchanged.

## Install

Tested with Pi 1.6.0 on macOS arm64. For a private GitHub repository, Git must already have read access. The first call needs Go 1.25+ on `PATH`, a writable package directory, and access to the Go modules (network or a populated Go cache).

```sh
pi install git:github.com/seefs001/pi-moejs
```

If upgrading from 0.1.x, run `pi update --extension git:github.com/seefs001/pi-moejs` and change any explicit `moe_codemode` tool selection to `codemode`. Existing `+codemode` selections work unchanged. Start a new Pi session or run `/reload`. Ask Pi: **“Use `codemode` to read `package.json` and return just the package name.”**

Pi 1.6.0 marks its built-in extension as replaceable. Installing this package is enough; you do not need to disable `builtin:codemode` or patch Pi. A startup warning that the built-in extension “was not loaded” is expected: it confirms Pi selected the replacement. To restore the stock QuickJS implementation, remove this package with `pi remove git:github.com/seefs001/pi-moejs` and reload.

The helper is built on first use, not during installation. The binary is cached under the package's `bin/` directory by source hash, OS and architecture. From a checkout, you can prebuild it with `node build.mjs` or run the extension without installing it:

```sh
bun install --omit peer --ignore-scripts
node build.mjs
pi -e ./index.ts --tools read,codemode
```

## Verify the running engine

Ask Pi: **“Call `codemode` with the following script and show me the tool result.”**

```js
return globalThis.codemodeRuntime?.() ?? 'No pi-moejs runtime probe';
```

With this extension (0.3.0+), a native function in the executing Go helper returns `engine` (`moejs`), `module` (`github.com/MoeForge/moejs`), `version` (such as `v0.1.1`), and `pid`. The module comes from the active runtime's Go type and the version from the running binary's build information (null when unavailable). Stock Pi QuickJS and older plugin versions have no probe; absence alone does not identify an engine.

For an independent check on macOS/Linux, run `ps -p <pid> -o pid=,comm=` in a terminal before the helper idles out. The PID should identify `moejs-helper`. This diagnoses which local backend answered; it is not cryptographic attestation against a modified host.

## Script example

This is the `code` argument to `codemode`. Only the summary goes back to the model.

```js
const paths = ['package.json', 'README.md'];
const files = await Promise.all(paths.map(path => tools.read({ path, limit: 20 })));
return paths.map((path, i) => ({ path, characters: files[i].length }));
```

- `ALL_TOOLS` lists callable tool names and signatures. `tools.<name>(args)` goes through Pi's nested tool pipeline, including validation and permission hooks. A tool can still read files or use the network if the Pi session allows it; the JavaScript runtime itself has no Node APIs, timers or `fetch`.
- Use `return`, `text()`, `image()`, `console.*` or `exit()`. `store(key, value)` / `load(key)` keep JSON data on the current Pi session branch after a successful script. This uses Pi's `codemode-store` entries, so values written by stock `codemode` remain available and vice versa. The old 0.1.x `moe_codemode` store is not merged into it.
- Set script options on the first line, e.g. `// @options: {"timeout_ms": 10000, "max_output_tokens": 2000}`. The default deadline is 60 seconds (maximum 10 minutes), excluding initial helper compilation. The text budget is approximate. Omitted text is not saved to a spill file.
- Each script gets a fresh VM with a 256 MiB MoeJS memory limit. One local Go process is reused per extension instance. Scripts execute sequentially; tool calls **inside** a script may run concurrently. Cancellation or timeout kills the busy helper and aborts pending nested calls; it cannot undo completed tool side effects. An idle helper exits after 60 seconds, or on session shutdown.
- This is not full `codemode` compatibility. No `models.*`, tool-search helpers, deterministic replay or native codemode-only prompt mode. If a workflow needs those features, remove the extension and reload to restore the built-in tool.

## When it helps

A local prototype comparison on an Apple M4 Max (Pi 1.6.0, MoeJS 0.1.1; 60 warm samples per scenario) found median latency of 20.81 ms with stock Pi versus 3.68 ms with the MoeJS sidecar for four parallel local file reads. A tool waiting 250 ms took 272.78 ms versus 253.73 ms. Keeping a QuickJS worker alive without changing engines also gave 5.34 ms on the file-read workload. These are prototype measurements, **not** a benchmark of this release or a claim about model latency. First-time Go compilation is not included.

## License

MIT. The embedded JS prelude is from `@earendil-works/pi-codemode` 1.6.0, with its [original license](native/PI-LICENSE). The helper uses MoeJS 0.1.1.
