// PR-7's argument validate-and-repair layer -- the spike's #1 requirement.
// Small/mid-tier open models mangle tool-call arguments in predictable ways
// (observed in the spike: `dc` returned as `{"type":"integer","value":15}`,
// a numeric field returned as the string `"25"`). Before invoking a tool
// handler, we repair those common shapes and THEN validate against the
// tool's own zod schema (the same schema createDmTools() built the handler
// around) -- so a repaired call is guaranteed to be exactly what the handler
// would have received from a well-behaved model. Unrepairable args never
// throw: they come back as a plain error string so the caller can feed an
// `ERROR: ...` tool result back to the model and let it self-correct on the
// next step (mirrors how a real engine ERROR already works today).

import { z } from 'zod';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

export type ArgRepairResult = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

/**
 * Unwraps a JSON-Schema-shaped wrapper value, e.g. `{"type":"integer","value":15}`
 * -> `15`, or `{"type":"string","value":"d20+3"}` -> `"d20+3"`. Deliberately
 * narrow (exactly the keys `type` + `value`, `type` a string, nothing else)
 * so it can't accidentally eat a legitimate object value -- none of this
 * project's 11 tools take an object-shaped argument, so any object arg is
 * either this exact malformation or genuinely wrong either way.
 */
function unwrapJsonSchemaValue(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    'type' in value &&
    'value' in value &&
    typeof (value as { type: unknown }).type === 'string'
  ) {
    return (value as { value: unknown }).value;
  }
  return value;
}

/**
 * Repairs and validates one tool call's arguments against `tool`'s zod input
 * shape. Repair steps, in order:
 *   1. drop any key not present in the tool's schema (unknown-key noise);
 *   2. unwrap JSON-Schema-shaped wrapper values on every remaining key;
 *   3. validate; if that fails specifically because a field zod expected to
 *      be a number/integer arrived as a numeric string, coerce exactly those
 *      fields to numbers and validate once more.
 * Never throws -- an unrepairable result comes back as `{ ok: false, error }`
 * with a human-readable reason (zod's own issue messages, joined), suitable
 * to hand straight to the model as `ERROR: <error>`.
 */
export function repairAndValidateArgs(tool: SdkMcpToolDefinition<any>, rawArgs: unknown): ArgRepairResult {
  if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) {
    return { ok: false, error: `expected a JSON object of arguments for ${tool.name}, got ${JSON.stringify(rawArgs)}` };
  }

  const schema = z.object(tool.inputSchema);
  const known = new Set(Object.keys(tool.inputSchema));

  const candidate: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawArgs as Record<string, unknown>)) {
    if (!known.has(key)) continue; // drop unknown keys
    candidate[key] = unwrapJsonSchemaValue(value);
  }

  let result = schema.safeParse(candidate);
  if (result.success) return { ok: true, args: result.data as Record<string, unknown> };

  // Numeric-string coercion, but ONLY for fields zod flagged as wanting a
  // number and receiving a string -- never blindly coerce every field, that
  // would mask genuinely wrong types with a confusing NaN instead of a clear
  // ERROR.
  let coercedAny = false;
  for (const issue of result.error.issues) {
    if (issue.code !== 'invalid_type' || issue.path.length !== 1) continue;
    if (issue.expected !== 'number') continue;
    const key = String(issue.path[0]);
    const value = candidate[key];
    if (typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(Number(value))) {
      candidate[key] = Number(value);
      coercedAny = true;
    }
  }

  if (coercedAny) {
    result = schema.safeParse(candidate);
    if (result.success) return { ok: true, args: result.data as Record<string, unknown> };
  }

  const reason = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
  return { ok: false, error: `invalid arguments for ${tool.name}: ${reason}` };
}
