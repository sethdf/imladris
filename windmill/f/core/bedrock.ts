// Shared Bedrock API helper for all devops pipeline AI calls.
// Uses @aws-sdk/client-bedrock-runtime InvokeModelCommand — works in Docker workers.
//
// Usage:
//   import { bedrockInvoke, MODELS } from "./bedrock.ts";
//   const text = await bedrockInvoke("Extract entities from: ...");
//   const json = await bedrockInvoke("Classify: ...", { model: MODELS.HAIKU, parseJson: true });

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

export const MODELS = {
  OPUS: "us.anthropic.claude-opus-4-6-v1",
  SONNET: "us.anthropic.claude-sonnet-4-20250514-v1:0",
  HAIKU: "us.anthropic.claude-3-5-haiku-20241022-v1:0",
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS] | string;

interface BedrockOptions {
  model?: ModelId;
  maxTokens?: number;
  system?: string;
  timeoutMs?: number;
  parseJson?: boolean;
}

interface BedrockResponse {
  text: string;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  stop_reason: string;
}

// Lazy singleton client
let _client: BedrockRuntimeClient | null = null;
function getClient(): BedrockRuntimeClient {
  if (!_client) {
    _client = new BedrockRuntimeClient({ region: "us-east-1" });
  }
  return _client;
}

/**
 * Invoke a Bedrock model with a prompt. Returns the response text (or parsed JSON if parseJson=true).
 *
 * @param prompt - The user message to send
 * @param options - Model, max tokens, system prompt, timeout, JSON parsing
 * @returns The response text or parsed JSON object
 */
export async function bedrockInvoke(prompt: string, options: BedrockOptions & { parseJson: true }): Promise<any>;
export async function bedrockInvoke(prompt: string, options?: BedrockOptions): Promise<string>;
export async function bedrockInvoke(prompt: string, options: BedrockOptions = {}): Promise<string | any> {
  const {
    model = MODELS.SONNET,
    maxTokens = 1024,
    system,
    timeoutMs = 60000,
    parseJson = false,
  } = options;

  const messages: Array<{ role: string; content: string }> = [
    { role: "user", content: prompt },
  ];

  const body: Record<string, any> = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: maxTokens,
    messages,
  };

  if (system) {
    body.system = system;
  }

  const client = getClient();
  const command = new InvokeModelCommand({
    modelId: model,
    contentType: "application/json",
    accept: "application/json",
    body: new TextEncoder().encode(JSON.stringify(body)),
  });

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const result = await client.send(command, { abortSignal: abortController.signal });
    clearTimeout(timer);

    const responseBody = new TextDecoder().decode(result.body);
    const response = JSON.parse(responseBody) as {
      content: Array<{ type: string; text: string }>;
      usage: { input_tokens: number; output_tokens: number };
      model: string;
      stop_reason: string;
    };

    const text = response.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");

    if (parseJson) {
      return extractJson(text);
    }

    return text;
  } catch (err: any) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Extract and parse JSON from a text response that may contain markdown fences or surrounding text.
 */
function extractJson(text: string): any {
  // Strip markdown code fences
  let cleaned = text
    .replace(/^[\s\n]*```(?:json)?\s*\n?/i, "")
    .replace(/\n?\s*```[\s\n]*$/i, "")
    .trim();

  // Try direct parse first
  try {
    return JSON.parse(cleaned);
  } catch {}

  // Find JSON object boundaries
  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      return JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
    } catch {}
  }

  // Find JSON array boundaries
  const arrStart = cleaned.indexOf("[");
  const arrEnd = cleaned.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      return JSON.parse(cleaned.slice(arrStart, arrEnd + 1));
    } catch {}
  }

  throw new Error(`Could not extract JSON from response: ${text.slice(0, 200)}`);
}
