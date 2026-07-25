// Step 0 spike: de-risk query() on subscription auth + in-process MCP tool +
// streaming input + settingSources: [] before any game code is built.
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

let toolCalled = false;
let gotText = false;
let assistantText = '';

const rollDice = tool(
  'roll_dice',
  'Roll a die with the given number of sides and report the result.',
  { sides: z.number().int().min(2).max(1000), reason: z.string() },
  async ({ sides, reason }) => {
    const n = Math.floor(Math.random() * sides) + 1;
    toolCalled = true;
    console.error(`[tool] roll_dice(sides=${sides}, reason="${reason}") -> ${n}`);
    return { content: [{ type: 'text', text: `Rolled d${sides}: ${n}` }] };
  },
  { annotations: { readOnlyHint: true } },
);

const dndServer = createSdkMcpServer({ name: 'dnd', tools: [rollDice] });

async function* userMessages(): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: 'I attack the goblin with my sword!' },
    parent_tool_use_id: null,
  };
}

async function main(): Promise<void> {
  const q = query({
    prompt: userMessages(),
    options: {
      settingSources: [],
      allowedTools: ['mcp__dnd__roll_dice'],
      tools: [], // disable ALL built-in tools (Bash/Read/Write/etc.) — MCP tools are separate
      mcpServers: { dnd: dndServer },
      maxTurns: 4,
      includePartialMessages: true,
      systemPrompt:
        'You are a fantasy dungeon master. When the player attempts an attack you MUST call the roll_dice tool exactly once, then narrate the outcome in 2-3 sentences.',
    },
  });

  for await (const message of q) {
    console.error(`[message] type=${message.type}`);

    if (message.type === 'stream_event') {
      const event = message.event;
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        gotText = true;
        assistantText += event.delta.text;
        process.stdout.write(event.delta.text);
      }
    }

    if (message.type === 'result') {
      console.error(`[result] subtype=${message.subtype} is_error=${message.is_error}`);
      console.error(`[result] total_cost_usd=${message.total_cost_usd}`);
      console.error(`[result] usage=${JSON.stringify(message.usage)}`);
      if (message.subtype === 'success') {
        console.error(`[result] final result text: ${message.result}`);
      }
    }

    if (message.type === 'system' && message.subtype === 'init') {
      console.error(`[system/init] model=${message.model}`);
      console.error(`[system/init] tools=${JSON.stringify(message.tools)}`);
      console.error(`[system/init] mcp_servers=${JSON.stringify(message.mcp_servers)}`);
    }
  }

  process.stdout.write('\n');
  if (gotText && toolCalled) {
    console.error('SPIKE RESULT: PASS');
    process.exit(0);
  } else {
    console.error(`SPIKE RESULT: FAIL (text=${gotText}, tool=${toolCalled})`);
    process.exit(1);
  }
}

const timeout = setTimeout(() => {
  console.error('SPIKE RESULT: TIMEOUT');
  process.exit(2);
}, 180_000);

main()
  .catch((err) => {
    console.error('[fatal error]', err);
    process.exit(1);
  })
  .finally(() => {
    clearTimeout(timeout);
  });
