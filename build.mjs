import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const native = fileURLToPath(new URL('./native/', import.meta.url));
const bin = fileURLToPath(new URL('./bin/', import.meta.url));
const exec = promisify(execFile);

// Cache by source, target and dependency checksums. Do not build at install or Pi startup.
export async function ensureHelper(signal) {
  const hash = createHash('sha256');
  for (const file of ['go.mod', 'go.sum', 'main.go', 'prelude.js']) hash.update(await readFile(join(native, file)));
  const target = join(bin, `${process.platform}-${process.arch}-${hash.digest('hex').slice(0, 16)}`);
  const binary = join(target, process.platform === 'win32' ? 'moejs-helper.exe' : 'moejs-helper');
  try { await access(binary); return binary; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await mkdir(target, { recursive: true });
  const temp = await mkdtemp(join(target, 'build-'));
  try {
    const artifact = join(temp, basename(binary));
    await exec('go', ['build', '-mod=readonly', '-trimpath', '-o', artifact, '.'], {
      cwd: native, signal, timeout: 180_000,
      env: { ...process.env, GOWORK: 'off', CGO_ENABLED: '0', GOOS: '', GOARCH: '' },
    });
    await rename(artifact, binary);
    return binary;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Building the MoeJS helper requires Go 1.25+ on PATH. Install Go and retry.');
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) ensureHelper().then(console.log).catch(error => { console.error(error.message); process.exitCode = 1; });
