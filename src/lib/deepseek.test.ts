import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DEEPSEEK_API_KEY = "test-key";
process.env.DEEPSEEK_BASE_URL = "https://deepseek.test";

const { createChatCompletion } = await import("./deepseek.js");

type CapturedRequest = {
  thinking?: { type?: string };
  reasoning_effort?: string;
  temperature?: number;
  max_tokens?: number;
};

function mockFetch(payload: unknown, onBody: (body: CapturedRequest) => void) {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    onBody(JSON.parse(String(init?.body ?? "{}")) as CapturedRequest);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

test("thinking mode sends reasoning controls and returns reasoning_content", async () => {
  const original = globalThis.fetch;
  let captured: CapturedRequest = {};

  globalThis.fetch = mockFetch(
    {
      model: "deepseek-flash",
      choices: [
        {
          message: {
            content: '{"intent":"CLARIFY"}',
            reasoning_content: "I thought about the transaction.",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    },
    (body) => {
      captured = body;
    },
  );

  try {
    const result = await createChatCompletion([{ role: "user", content: "hi" }], {
      thinking: true,
      reasoningEffort: "max",
      maxTokens: 2_000,
    });

    assert.equal(captured.thinking?.type, "enabled");
    assert.equal(captured.reasoning_effort, "max");
    assert.equal(captured.max_tokens, 2_000);
    assert.equal(captured.temperature, undefined);
    assert.equal(result.reasoning, "I thought about the transaction.");
  } finally {
    globalThis.fetch = original;
  }
});

test("thinking disabled sends the fast extraction defaults", async () => {
  const original = globalThis.fetch;
  let captured: CapturedRequest = {};

  globalThis.fetch = mockFetch(
    {
      model: "deepseek-flash",
      choices: [{ message: { content: '{"intent":"CLARIFY"}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
    (body) => {
      captured = body;
    },
  );

  try {
    const result = await createChatCompletion([{ role: "user", content: "hi" }]);

    assert.equal(captured.thinking?.type, "disabled");
    assert.equal(captured.reasoning_effort, undefined);
    assert.equal(captured.temperature, 0.1);
    assert.equal(result.reasoning, null);
  } finally {
    globalThis.fetch = original;
  }
});
