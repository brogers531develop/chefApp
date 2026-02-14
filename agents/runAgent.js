import OpenAI from "openai";
import { SYSTEM_PROMPTS } from "./prompts.js";

/**
 * GPT-5.x models reject custom temperature; GPT-4.x supports it.
 * We only attach temperature when it's allowed.
 */
function supportsTemperature(model) {
  return typeof model === "string" && model.startsWith("gpt-4");
}

/**
 * Extract the first ```json ... ``` fenced block as an object (artifact).
 */
function extractFirstJsonBlock(text) {
  const m = String(text || "").match(/```json\s*([\s\S]*?)\s*```/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * Remove JSON fenced block from the visible message text.
 */
function stripJsonBlock(text) {
  return String(text || "").replace(/```json[\s\S]*?```/gi, "").trim();
}

/**
 * Minimal mocks so your UI still works without an API key.
 */
function mock(agentKey, task) {
  if (agentKey === "chef") {
    return {
      message: "Mock Chef: Plan drafted. (Add OPENAI_API_KEY to use real model.)",
      artifact: {
        plan: ["Prep", "Cook", "Plate"],
        shoppingList: [{ item: "example ingredient", qty: 1 }],
        timeline: [{ t: "00:00", step: "Start" }]
      }
    };
  }
  if (agentKey === "purchasing") {
    return {
      message: "Mock Purchasing: Purchase order generated.",
      artifact: { purchaseOrder: [{ item: "example ingredient", qty: 1 }] }
    };
  }
  if (agentKey === "delivery") {
    return {
      message: "Mock Delivery: Delivery plan generated.",
      artifact: { deliveryPlan: [{ stop: 1, action: "Pick up items", eta: "30m" }] }
    };
  }
  if (agentKey === "analyzer") {
    return {
      message: "Mock Analyzer: Convergence notes generated.",
      artifact: null
    };
  }
  return { message: "Mock agent response.", artifact: null };
}

/**
 * runAgent() — one function used by server.js
 */
export async function runAgent({ agentKey, task, model }) {
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey.trim()) return mock(agentKey, task);

  const client = new OpenAI({ apiKey });

  const system = SYSTEM_PROMPTS?.[agentKey] || "";
  const user = `${task}

If you include an artifact, put it in exactly ONE JSON code block like:

\`\`\`json
{ "ok": true }
\`\`\`
`;

  // ✅ messages defined here (this is what your server error is about)
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: user }
  ];

  // ✅ Build payload safely
  const payload = { model, messages };
  if (supportsTemperature(model)) payload.temperature = 0.7;

  // ✅ Use Chat Completions API (consistent with `messages`)
  const response = await client.chat.completions.create(payload);

  const text = response?.choices?.[0]?.message?.content?.trim() || "";
  const artifact = extractFirstJsonBlock(text);
  const message = stripJsonBlock(text);

  return { message, artifact };
}
