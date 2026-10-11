import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const MAX_TEXT = 60_000;

export function json(value: unknown): CallToolResult {
  let text = JSON.stringify(value, (_k, v) => (v === undefined ? undefined : v), 2);
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n... [truncated ${text.length - MAX_TEXT} characters]`;
  return { content: [{ type: "text", text }] };
}

export function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

export function fail(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** Wraps a tool handler so thrown errors become MCP tool errors instead of protocol errors. */
export function safe<A extends unknown[]>(fn: (...args: A) => Promise<CallToolResult>) {
  return async (...args: A): Promise<CallToolResult> => {
    try {
      return await fn(...args);
    } catch (err) {
      return fail(err);
    }
  };
}

export const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
