import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { CodemodeSandboxBase } from '@earendil-works/pi-codemode';

type Launch = ConstructorParameters<typeof CodemodeSandboxBase>[1];
type Events = Parameters<Launch>[1];

/** One sidecar per extension instance. One fresh realm per script. */
export class Sidecar {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private idle?: ReturnType<typeof setTimeout>;

  private reference(child: ChildProcessWithoutNullStreams, keepAlive: boolean) {
    const method = keepAlive ? 'ref' : 'unref';
    child[method]();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      (stream as { ref?: () => void; unref?: () => void })[method]?.();
    }
  }
  private active?: { id: number; events: Events; finished: boolean };

  private discard() {
    clearTimeout(this.idle);
    const child = this.child;
    this.child = undefined;
    child?.kill('SIGKILL');
  }

  close() {
    this.discard();
    this.active?.events.failure({ kind: 'aborted', message: 'Pi session closed' });
  }

  private start(binary: string) {
    clearTimeout(this.idle);
    if (this.child) {
      this.reference(this.child, true);
      return this.child;
    }
    const child = spawn(binary, [], { stdio: 'pipe', windowsHide: true });
    this.child = child;
    let stderr = '';
    const fail = (message: string) => {
      if (this.child !== child) return;
      this.discard();
      this.active?.events.failure({ kind: 'sandbox', message });
    };
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-2048); });
    child.on('error', e => fail(e.message));
    child.stdin.on('error', e => fail(e.message));
    child.once('close', (code, signal) => fail(`MoeJS exited (${signal ?? code}). ${stderr}`.trim()));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
      const active = this.active;
      if (child !== this.child || !active) return;
      try {
        const { run, ...msg } = JSON.parse(line);
        if (run !== active.id) return;
        if (msg.type === 'done') active.finished = true;
        active.events.message(msg);
      } catch (e) { fail(`Invalid MoeJS response: ${e}`); }
    });
    return child;
  }

  launcher(binary: string, timeoutMs: number): Launch {
    return (data, events) => {
      if (this.active) throw new Error('Another MoeJS script is running');
      const child = this.start(binary);
      const active = this.active = { id: ++this.nextId, events, finished: false };
      const send = (msg: object) => child.stdin.write(JSON.stringify({ ...msg, run: active.id }) + '\n');
      send({ type: 'run', ...data, timeoutMs });
      return {
        post: msg => { if (this.active === active) send(msg); },
        stop: async () => {
          if (this.active !== active) return;
          this.active = undefined;
          // A timeout, abort or protocol failure must discard even a CPU-bound runtime.
          if (!active.finished) this.discard();
          else if (this.child === child) {
            this.reference(child, false);
            this.idle = setTimeout(() => this.discard(), 60_000);
            this.idle.unref();
          }
        },
      };
    };
  }
}
