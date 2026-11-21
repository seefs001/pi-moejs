import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HELPER_INPUTS } from '../build.mjs';
import { PRELUDE_SOURCE } from '../node_modules/@earendil-works/pi-codemode/dist/runtime/prelude-source.js';

const execFileAsync = promisify(execFile);
const rootDir = fileURLToPath(new URL('..', import.meta.url));
const nativeDir = join(rootDir, 'native');

const failures = [];

function fail(message) {
  failures.push(message);
}

async function checkPackageManifest() {
  const manifest = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'));
  const scripts = manifest.scripts ?? {};
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (hook in scripts) {
      fail(`package.json must not define "${hook}" lifecycle script; helper compiles on first use.`);
    }
  }
  const extensions = manifest.pi?.extensions ?? [];
  if (!extensions.includes('./index.ts')) {
    fail('package.json pi.extensions must include "./index.ts".');
  }
}

async function checkHelperInputs() {
  const entries = await readdir(nativeDir);
  const expected = entries
    .filter((name) => name === 'go.mod' || name === 'go.sum' || name === 'prelude.js' || (name.endsWith('.go') && !name.endsWith('_test.go')))
    .toSorted();
  const actual = HELPER_INPUTS.toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`HELPER_INPUTS in build.mjs (${actual.join(', ')}) does not match native build inputs (${expected.join(', ')}).`);
  }
}

async function checkVendoredPrelude() {
  const local = await readFile(join(nativeDir, 'prelude.js'), 'utf8');
  const body = local.replace(/^\/\/[^\n]*\n/, '');
  if (body.trim() !== PRELUDE_SOURCE.trim()) {
    fail('native/prelude.js does not match @earendil-works/pi-codemode PRELUDE_SOURCE.');
  }
}

async function checkGo() {
  const { stdout: unformatted } = await execFileAsync('gofmt', ['-l', '.'], { cwd: nativeDir });
  if (unformatted.trim()) {
    fail(`Unformatted Go files:\n${unformatted.trim()}`);
  }
  await execFileAsync('go', ['vet', './...'], { cwd: nativeDir });
  await execFileAsync('go', ['test', '-run', '^TestNoGoComments$', './...'], { cwd: nativeDir });
}

await checkPackageManifest();
await checkHelperInputs();
await checkVendoredPrelude();
await checkGo();

if (failures.length > 0) {
  for (const message of failures) {
    console.error(message);
  }
  process.exitCode = 1;
}
