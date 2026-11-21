import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const nativeDir = fileURLToPath(new URL('./native/', import.meta.url));
const binDir = fileURLToPath(new URL('./bin/', import.meta.url));
const execFileAsync = promisify(execFile);

export const HELPER_INPUTS = ['go.mod', 'go.sum', 'main.go', 'prelude.js'];

export async function ensureHelper(signal) {
  const hash = createHash('sha256');
  for (const file of HELPER_INPUTS) {
    hash.update(await readFile(join(nativeDir, file)));
  }
  const targetDir = join(binDir, `${process.platform}-${process.arch}-${hash.digest('hex').slice(0, 16)}`);
  const binaryPath = join(targetDir, process.platform === 'win32' ? 'moejs-helper.exe' : 'moejs-helper');
  try {
    await access(binaryPath);
    return binaryPath;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(targetDir, { recursive: true });
  const tempDir = await mkdtemp(join(targetDir, 'build-'));
  try {
    const artifactPath = join(tempDir, basename(binaryPath));
    await execFileAsync('go', ['build', '-mod=readonly', '-trimpath', '-o', artifactPath, '.'], {
      cwd: nativeDir,
      signal,
      timeout: 180_000,
      env: { ...process.env, GOWORK: 'off', CGO_ENABLED: '0', GOOS: '', GOARCH: '' },
    });
    await rename(artifactPath, binaryPath);
    return binaryPath;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('Go 1.25+ is required on PATH to build moejs-helper.', { cause: error });
    }
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  ensureHelper()
    .then((binaryPath) => {
      console.log(binaryPath);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
