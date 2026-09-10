/**
 * End-to-end smoke tests against a running relay.
 *
 *   bun run scripts/smoke.ts [basic|stream|tools|all]
 *
 * Reads RELAY_URL (default http://127.0.0.1:8787), RELAY_API_KEY and
 * RELAY_SMOKE_MODEL. These hit the real Claude subscription, so they are not
 * part of `bun test`.
 */
const base = process.env.RELAY_URL ?? "http://127.0.0.1:8787";
const apiKey = process.env.RELAY_API_KEY ?? "";
const model = process.env.RELAY_SMOKE_MODEL ?? "claude-sonnet-5";

function headers(): Record<string, string> {
  return {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    ...(apiKey ? { "x-api-key": apiKey } : {}),
  };
}

async function post(body: unknown): Promise<Response> {
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  return response;
}

function fail(message: string): never {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

function textOf(content: Array<Record<string, unknown>>): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => String(block.text))
    .join("");
}

async function basic(): Promise<void> {
  const response = await post({
    model,
    max_tokens: 256,
    messages: [{ role: "user", content: "Reply with exactly: pong" }],
  });
  if (!response.ok) fail(`basic: HTTP ${response.status} ${await response.text()}`);
  const body = (await response.json()) as Record<string, any>;
  if (body.stop_reason !== "end_turn") fail(`basic: stop_reason was ${body.stop_reason}`);
  const text = textOf(body.content);
  if (!text.trim()) fail("basic: empty content");
  console.log(`PASS  basic — ${JSON.stringify(text.slice(0, 80))}`);
}

async function stream(): Promise<void> {
  const response = await post({
    model,
    max_tokens: 256,
    stream: true,
    messages: [{ role: "user", content: "Count from one to five, words only." }],
  });
  if (!response.ok) fail(`stream: HTTP ${response.status} ${await response.text()}`);

  const events: string[] = [];
  let text = "";
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const event = /^event: (.+)$/m.exec(chunk)?.[1];
      const data = /^data: (.+)$/m.exec(chunk)?.[1];
      if (!event) continue;
      events.push(event);
      if (event === "content_block_delta" && data) {
        const parsed = JSON.parse(data);
        if (parsed.delta?.type === "text_delta") text += parsed.delta.text;
      }
      if (event === "error") fail(`stream: ${data}`);
    }
  }

  if (events[0] !== "message_start") fail(`stream: first event was ${events[0]}`);
  if (events.at(-1) !== "message_stop") fail(`stream: last event was ${events.at(-1)}`);
  const starts = events.filter((e) => e === "content_block_start").length;
  const stops = events.filter((e) => e === "content_block_stop").length;
  if (starts !== stops) fail(`stream: ${starts} block starts vs ${stops} stops`);
  if (!text.trim()) fail("stream: no text deltas");
  console.log(`PASS  stream — ${events.length} events, ${JSON.stringify(text.slice(0, 80))}`);
}

async function tools(): Promise<void> {
  const toolDefinition = {
    name: "get_weather",
    description: "Get the current weather for a city. Always use this; you have no other source.",
    input_schema: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  };
  const first = [
    { role: "user" as const, content: "What is the weather in Graz right now? Use the tool." },
  ];

  const response = await post({ model, max_tokens: 512, tools: [toolDefinition], messages: first });
  if (!response.ok) fail(`tools: HTTP ${response.status} ${await response.text()}`);
  const body = (await response.json()) as Record<string, any>;
  if (body.stop_reason !== "tool_use") {
    fail(`tools: expected stop_reason tool_use, got ${body.stop_reason} — ${textOf(body.content)}`);
  }
  const call = body.content.find((block: any) => block.type === "tool_use");
  if (!call) fail("tools: no tool_use block");
  if (call.name !== "get_weather") fail(`tools: called ${call.name}`);
  console.log(`PASS  tools/call — ${call.name}(${JSON.stringify(call.input)})`);

  const second = await post({
    model,
    max_tokens: 512,
    tools: [toolDefinition],
    messages: [
      ...first,
      { role: "assistant", content: body.content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: call.id,
            content: "Heavy snow, minus 4 degrees Celsius.",
          },
        ],
      },
    ],
  });
  if (!second.ok) fail(`tools: HTTP ${second.status} ${await second.text()}`);
  const followUp = (await second.json()) as Record<string, any>;
  if (followUp.stop_reason !== "end_turn") {
    fail(`tools: follow-up stop_reason was ${followUp.stop_reason}`);
  }
  const answer = textOf(followUp.content);
  if (!/snow/i.test(answer)) fail(`tools: answer ignored the tool result — ${answer}`);
  console.log(`PASS  tools/resume — ${JSON.stringify(answer.slice(0, 120))}`);
}

const which = process.argv[2] ?? "all";
const suites: Record<string, () => Promise<void>> = { basic, stream, tools };

if (which === "all") {
  for (const run of Object.values(suites)) await run();
} else if (suites[which]) {
  await suites[which]!();
} else {
  fail(`unknown suite ${which}; expected basic, stream, tools or all`);
}
