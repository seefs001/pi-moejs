import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  CODEMODE_SOURCE_GRAMMAR,
  CodemodeSandboxBase,
  parseCodemodeSource,
  renderToolSample,
  type CodemodeJsonSchema,
  type CodemodeResult,
  type CodemodeStoreWrites,
} from '@earendil-works/pi-codemode';
import { Type } from 'typebox';
import { ensureHelper } from './build.mjs';
import { Sidecar } from './sidecar.ts';

const TOOL_NAME = 'codemode';
const STORE_ENTRY_TYPE = 'codemode-store';
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const MAX_OUTPUT_TOKENS = 50_000;
const CHARS_PER_TOKEN = 4;
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const MAX_ERROR_CHARS = 4096;

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

function isStoreWrites(value: unknown): value is CodemodeStoreWrites {
  if (typeof value !== 'object' || value === null) return false;
  if (!('set' in value) || !('delete' in value)) return false;
  return (
    typeof value.set === 'object' &&
    value.set !== null &&
    Array.isArray(value.delete) &&
    value.delete.every((key) => typeof key === 'string')
  );
}

function readStore(ctx: ExtensionContext) {
  const state = new Map<string, unknown>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== 'custom' || entry.customType !== STORE_ENTRY_TYPE) continue;
    if (!isStoreWrites(entry.data)) continue;
    for (const key of entry.data.delete) state.delete(key);
    for (const [key, value] of Object.entries(entry.data.set)) state.set(key, value);
  }
  return Object.fromEntries(state);
}

function formatOutput(result: CodemodeResult, budgetChars: number): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let remaining = budgetChars;
  let truncated = false;

  const pushText = (text: string) => {
    if (text.length > remaining) truncated = true;
    if (remaining > 0) blocks.push({ type: 'text', text: text.slice(0, remaining) });
    remaining = Math.max(0, remaining - text.length);
  };

  for (const item of result.output) {
    if (item.type === 'image') blocks.push(item);
    else pushText(item.text);
  }
  if (result.ok && result.value !== undefined) {
    pushText(
      typeof result.value === 'string'
        ? result.value
        : (JSON.stringify(result.value) ?? String(result.value)),
    );
  }
  if (truncated) {
    blocks.push({ type: 'text', text: '[Output truncated. Filter results inside the script.]' });
  }
  if (!result.ok) {
    blocks.push({
      type: 'text',
      text: `MoeJS ${result.error.kind}: ${result.error.message.slice(0, MAX_ERROR_CHARS)}`,
    });
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: 'Script completed without output.' }];
}

export default function moejs(pi: ExtensionAPI) {
  const helper = new Sidecar();
  const session = new AbortController();
  let binary: string | undefined;

  pi.on('session_shutdown', () => {
    session.abort();
    helper.close();
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: 'codemode (MoeJS)',
    exposure: 'model-only',
    executionMode: 'sequential',
    description:
      'Run a JavaScript async function body in MoeJS. Call Pi tools with await tools.<name>(args); inspect ALL_TOOLS for names and signatures. Output with return, text(), image(), console, or store()/load(). Call codemodeRuntime() for runtime info. No Node APIs, timers, or fetch.',
    parameters: Type.Object({
      code: Type.String({
        description: 'JavaScript source, optionally starting with a // @options: JSON line.',
      }),
    }),
    constrainedSampling: {
      type: 'grammar',
      variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR },
    },
    reachesTools: () => 'all',
    async execute(_id, { code: input }, signal, _onUpdate, ctx) {
      const { code, options } = parseCodemodeSource(input);
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      if (timeoutMs > MAX_TIMEOUT_MS) {
        throw new Error(`timeout_ms cannot exceed ${MAX_TIMEOUT_MS} (10 minutes).`);
      }

      const runSignal = signal ? AbortSignal.any([signal, session.signal]) : session.signal;
      runSignal.throwIfAborted();
      const helperBinary = (binary ??= await ensureHelper(runSignal));

      const guidelines = new Map(pi.getAllTools().map((tool) => [tool.name, tool.promptGuidelines ?? []]));
      const tools = ctx.tools
        .filter((tool) => tool.name !== TOOL_NAME)
        .map((tool) => ({
          name: tool.name,
          description: renderToolSample({
            name: tool.name,
            description: [tool.description, ...(guidelines.get(tool.name) ?? [])].join('\n'),
            inputSchema: tool.parameters as CodemodeJsonSchema,
            outputSchema: (tool.outputSchema ?? { type: 'string' }) as CodemodeJsonSchema,
          }),
          async execute(args: unknown, call: { signal: AbortSignal }) {
            const outcome = await ctx.executeTool(tool.name, args, { signal: call.signal });
            const { result } = outcome;
            if (tool.outputSchema && result.structuredContent !== undefined) {
              return result.structuredContent;
            }
            const text = result.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n');
            if (outcome.isError) throw new Error(text || `Tool ${tool.name} failed`);
            return text;
          },
        }));

      const sandbox = new CodemodeSandboxBase(
        { tools, timeoutMs, memoryLimitBytes: MEMORY_LIMIT_BYTES },
        helper.launcher(helperBinary, timeoutMs),
      );
      try {
        const result = await sandbox.execute(code, { signal: runSignal, store: readStore(ctx) });
        if (
          result.ok &&
          (Object.keys(result.storeWrites.set).length > 0 || result.storeWrites.delete.length > 0)
        ) {
          pi.appendEntry(STORE_ENTRY_TYPE, result.storeWrites);
        }
        const budgetChars =
          Math.min(options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS) *
          CHARS_PER_TOKEN;
        return {
          content: formatOutput(result, budgetChars),
          details: { runtime: 'moejs', calls: result.calls },
          isError: !result.ok,
        };
      } finally {
        await sandbox.close();
      }
    },
  });
}
