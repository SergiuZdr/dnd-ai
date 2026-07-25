// Converts the 11 engine tools' zod input schemas (already on
// createDmTools().tools[i].inputSchema -- a raw zod shape, see
// SdkMcpToolDefinition in the Agent SDK) into OpenAI `function` tool schemas,
// so the two definitions (what the Claude backend's MCP server exposes, and
// what the OpenAI backend puts in its `tools` request field) can never drift:
// this file derives the latter FROM the former via zod's own `z.toJSONSchema`
// rather than hand-maintaining a parallel schema (PR-6).

import { z } from 'zod';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

export interface OpenAiFunctionToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Converts one tool definition's zod input shape into an OpenAI function-tool schema. */
export function toolToOpenAiSchema(tool: SdkMcpToolDefinition<any>): OpenAiFunctionToolSchema {
  const objectSchema = z.object(tool.inputSchema);
  const jsonSchema = z.toJSONSchema(objectSchema) as Record<string, unknown>;
  // z.toJSONSchema stamps a `$schema` meta-key -- meaningful for a
  // standalone JSON Schema document, meaningless (and a little confusing)
  // nested inside an OpenAI tool's `function.parameters`, so drop it.
  delete jsonSchema.$schema;
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: jsonSchema,
    },
  };
}

/** Converts createDmTools().tools (all 11) into the `tools` array an OpenAI-compatible /v1/chat/completions request expects. */
export function toolsToOpenAiSchemas(tools: SdkMcpToolDefinition<any>[]): OpenAiFunctionToolSchema[] {
  return tools.map(toolToOpenAiSchema);
}
