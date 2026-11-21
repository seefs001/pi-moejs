# pi-moejs

Replaces Pi's built-in `codemode` runtime with [MoeJS](https://github.com/MoeForge/moejs). Scripts run through the same `codemode` tool and Pi's nested tool pipeline.

## Install

Requires Pi 1.6.0 and Go 1.25+ on `PATH`.

```sh
pi install git:github.com/seefs001/pi-moejs
```

Start a new Pi session or run `/reload`. Pi skips its built-in `codemode` extension automatically when another extension registers `codemode`. Run `pi remove git:github.com/seefs001/pi-moejs` and reload to switch back to QuickJS.

The Go helper compiles on first use and caches under `bin/` by source hash, OS, and architecture. To prebuild or run from a local checkout:

```sh
bun install --omit peer --ignore-scripts
node build.mjs
pi -e ./index.ts --tools read,codemode
```

## Runtime probe

Call `codemodeRuntime()` inside a script to inspect the active runtime:

```js
return codemodeRuntime();
```

Returns `{ engine, module, version, pid }`: `"moejs"`, `"github.com/MoeForge/moejs"`, the Go module version, and the helper process PID.

## Script environment

```js
const paths = ['package.json', 'README.md'];
const files = await Promise.all(paths.map(path => tools.read({ path, limit: 20 })));
return paths.map((path, i) => ({ path, characters: files[i].length }));
```

- `tools.<name>(args)` runs through Pi's tool pipeline, including validation and permission hooks. `ALL_TOOLS` lists callable names and signatures. The JS VM has no Node APIs, timers, or `fetch`.
- Scripts can output via `return`, `text()`, `image()`, `console.*`, and `exit()`. `store(key, value)` and `load(key)` persist JSON values on the current session branch using Pi's `codemode-store` entries.
- First-line options: `// @options: {"timeout_ms": 10000, "max_output_tokens": 2000}`. Timeout defaults to 60s (max 10m); output budget defaults to 10,000 tokens (max 50,000).
- Each script runs in a fresh MoeJS VM with a 256 MiB memory limit inside a reused local helper process. Scripts run sequentially while nested tool calls can run concurrently. Idle helpers exit after 60s or on session shutdown.
- Not included: `models.*`, tool-search helpers, deterministic replay, and codemode-only prompt mode.

## Development

```sh
bun run lint
bun run test
```

## License

MIT. `native/prelude.js` is vendored from `@earendil-works/pi-codemode` 1.6.0 under [its original license](native/PI-LICENSE).
