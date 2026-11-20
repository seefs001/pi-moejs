import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { CODEMODE_SOURCE_GRAMMAR, CodemodeSandboxBase, parseCodemodeSource, renderToolSample, type CodemodeJsonSchema, type CodemodeResult, type CodemodeStoreWrites } from '@earendil-works/pi-codemode';
import { Type } from 'typebox';
import { ensureHelper } from './build.mjs';
import { Sidecar } from './sidecar.ts';

// Pi's CLI skips its replaceable builtin when another extension owns this name.
const name = 'codemode';
const storeEntry = 'codemode-store';

function readStore(ctx: ExtensionContext) {
  const state = new Map<string, unknown>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== 'custom' || entry.customType !== storeEntry) continue;
    const delta = entry.data as CodemodeStoreWrites | undefined;
    if (!delta?.set || !Array.isArray(delta.delete)) continue;
    for (const key of delta.delete) state.delete(key);
    for (const [key, value] of Object.entries(delta.set)) state.set(key, value);
  }
  return Object.fromEntries(state);
}

type Block = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
function output(result: CodemodeResult, chars: number): Block[] {
  const blocks: Block[] = [];
  let omitted = false;
  const add = (s: string) => {
    if (s.length > chars) omitted = true;
    if (chars > 0) blocks.push({ type: 'text', text: s.slice(0, chars) });
    chars = Math.max(0, chars - s.length);
  };
  for (const item of result.output) {
    if (item.type === 'image') blocks.push(item);
    else add(item.text);
  }
  if (result.ok && result.value !== undefined) add(typeof result.value === 'string' ? result.value : JSON.stringify(result.value));
  if (omitted) blocks.push({ type: 'text', text: '[Text output truncated. Filter the result inside the script.]' });
  if (!result.ok) blocks.push({ type: 'text', text: `MoeJS ${result.error.kind}: ${result.error.message.slice(0, 4096)}` });
  return blocks.length ? blocks : [{ type: 'text', text: 'Script completed without output.' }];
}

export default function moejs(pi: ExtensionAPI) {
  const helper = new Sidecar();
  const session = new AbortController();
  let binary: string | undefined;
  pi.on('session_shutdown', () => { session.abort(); helper.close(); });

  pi.registerTool({
    name, label: 'codemode (MoeJS)', exposure: 'model-only', executionMode: 'sequential',
    description: 'Run a JavaScript async function body in MoeJS. Use await tools.name(args) to call Pi tools; use ALL_TOOLS for names and signatures. Use return, text(), image(), console, store()/load(). No Node APIs, network or timers. Example: return await tools.read({path:"README.md",limit:10}).',
    parameters: Type.Object({ code: Type.String({ description: 'JavaScript source, optionally preceded by a // @options: JSON line' }) }),
    constrainedSampling: { type: 'grammar', variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } },
    reachesTools: () => 'all',
    async execute(_id, { code: input }, signal, _onUpdate, ctx) {
      const { code, options } = parseCodemodeSource(input);
      const timeoutMs = options.timeoutMs ?? 60_000;
      if (timeoutMs > 600_000) throw new Error('timeout_ms cannot exceed 600000 (10 minutes).');
      const runSignal = signal ? AbortSignal.any([signal, session.signal]) : session.signal;
      runSignal.throwIfAborted();
      binary ??= await ensureHelper(runSignal);
      runSignal.throwIfAborted();
      const guidelines = new Map(pi.getAllTools().map(t => [t.name, t.promptGuidelines ?? []]));
      const tools = ctx.tools.filter(t => t.name !== name).map(t => ({
        name: t.name,
        description: renderToolSample({ name: t.name, description: [t.description, ...(guidelines.get(t.name) ?? [])].join('\n'), inputSchema: t.parameters as CodemodeJsonSchema, outputSchema: (t.outputSchema ?? { type: 'string' }) as CodemodeJsonSchema }),
        async execute(args: unknown, call: { signal: AbortSignal }) {
          const outcome = await ctx.executeTool(t.name, args, { signal: call.signal });
          const r = outcome.result;
          if (t.outputSchema && r.structuredContent !== undefined) return r.structuredContent;
          const text = r.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
          if (outcome.isError) throw new Error(text || `Tool ${t.name} failed`);
          return text;
        },
      }));
      const sandbox = new CodemodeSandboxBase({ tools, timeoutMs, memoryLimitBytes: 256 * 1024 * 1024 }, helper.launcher(binary!, timeoutMs));
      try {
        const result = await sandbox.execute(code, { signal: runSignal, store: readStore(ctx) });
        if (result.ok && (Object.keys(result.storeWrites.set).length || result.storeWrites.delete.length)) pi.appendEntry(storeEntry, result.storeWrites);
        return { content: output(result, Math.min(options.maxOutputTokens ?? 10_000, 50_000) * 4), details: { runtime: 'moejs', calls: result.calls }, isError: !result.ok };
      } finally { await sandbox.close(); }
    },
  });
}
