import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { CodemodeSandboxBase } from '@earendil-works/pi-codemode';

type Launch = ConstructorParameters<typeof CodemodeSandboxBase>[1];
type Events = Parameters<Launch>[1];

const IDLE_TIMEOUT_MS = 60_000;
const STDERR_TAIL_CHARS = 2048;

function setReferenced(handle: unknown, keepAlive: boolean) {
  if (typeof handle !== 'object' || handle === null) return;
  if (keepAlive) {
    if ('ref' in handle && typeof handle.ref === 'function') handle.ref();
  } else if ('unref' in handle && typeof handle.unref === 'function') {
    handle.unref();
  }
}

function parsePacketLine(line: string): { run: number; msg: Record<string, unknown> } | undefined {
  const raw: unknown = JSON.parse(line);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw);
  const runEntry = entries.find(([key]) => key === 'run');
  if (!runEntry || typeof runEntry[1] !== 'number') return undefined;
  const msg = Object.fromEntries(entries.filter(([key]) => key !== 'run'));
  return { run: runEntry[1], msg };
}

export class Sidecar {
  private child?: ChildProcessWithoutNullStreams;
  private active?: { id: number; events: Events; finished: boolean };
  private nextId = 0;
  private idle?: ReturnType<typeof setTimeout>;

  private setChildReferenced(child: ChildProcessWithoutNullStreams, keepAlive: boolean) {
    setReferenced(child, keepAlive);
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      setReferenced(stream, keepAlive);
    }
  }

  private killHelper() {
    clearTimeout(this.idle);
    const child = this.child;
    this.child = undefined;
    child?.kill('SIGKILL');
  }

  private parkIdle(child: ChildProcessWithoutNullStreams) {
    this.setChildReferenced(child, false);
    this.idle = setTimeout(() => this.killHelper(), IDLE_TIMEOUT_MS);
    this.idle.unref();
  }

  close() {
    this.killHelper();
    this.active?.events.failure({ kind: 'aborted', message: 'Pi session closed' });
  }

  private start(binary: string) {
    clearTimeout(this.idle);
    if (this.child) {
      this.setChildReferenced(this.child, true);
      return this.child;
    }
    const child = spawn(binary, [], { stdio: 'pipe', windowsHide: true });
    this.child = child;
    let stderr = '';
    const fail = (message: string) => {
      if (this.child !== child) return;
      this.killHelper();
      this.active?.events.failure({ kind: 'sandbox', message });
    };
    child.stderr.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-STDERR_TAIL_CHARS);
    });
    child.on('error', (error) => fail(error.message));
    child.stdin.on('error', (error) => fail(error.message));
    child.once('close', (code, signal) => fail(`MoeJS exited (${signal ?? code}). ${stderr}`.trim()));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      const active = this.active;
      if (child !== this.child || !active) return;
      try {
        const packet = parsePacketLine(line);
        if (!packet) {
          fail('Invalid MoeJS response: expected packet object');
          return;
        }
        if (packet.run !== active.id) return;
        if (packet.msg.type === 'done') active.finished = true;
        active.events.message(packet.msg);
      } catch (error) {
        fail(`Invalid MoeJS response: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    return child;
  }

  launcher(binary: string, timeoutMs: number): Launch {
    return (data, events) => {
      if (this.active) throw new Error('Another MoeJS script is running');
      const child = this.start(binary);
      const active = (this.active = { id: ++this.nextId, events, finished: false });
      const send = (msg: object) => child.stdin.write(`${JSON.stringify({ ...msg, run: active.id })}\n`);
      send({ type: 'run', ...data, timeoutMs });
      return {
        post: (msg) => {
          if (this.active === active) send(msg);
        },
        stop: async () => {
          if (this.active !== active) return;
          this.active = undefined;
          if (!active.finished) {
            this.killHelper();
            return;
          }
          if (this.child === child) {
            this.parkIdle(child);
          }
        },
      };
    };
  }
}
