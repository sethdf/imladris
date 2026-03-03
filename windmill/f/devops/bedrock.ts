// Shared Bedrock API helper for all devops pipeline AI calls.
// Replaces claude -p pipe mode — eliminates PAI context overhead, CLAUDECODE issues,
// and 40s latency. Uses AWS CLI under the hood (handles IAM credential resolution).
//
// Usage:
//   import { bedrockInvoke, MODELS } from "./bedrock.ts";
//   const text = await bedrockInvoke("Extract entities from: ...");
//   const json = await bedrockInvoke("Classify: ...", { model: MODELS.HAIKU, parseJson: true });

import { execSync } from "child_process";
import { writeFileSync, readFileSync, unlinkSync } from "fs";

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

  // Write body to temp file to handle large prompts without shell escaping issues
  const ts = Date.now();
  const bodyFile = `/tmp/bedrock-body-${ts}.json`;
  const outFile = `/tmp/bedrock-out-${ts}.json`;

  try {
    writeFileSync(bodyFile, JSON.stringify(body));

    execSync(
      `aws bedrock-runtime invoke-model` +
        ` --model-id '${model}'` +
        ` --body 'file://${bodyFile}'` +
        ` --cli-binary-format raw-in-base64-out` +
        ` ${outFile}`,
      { encoding: "utf-8", timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"] },
    );

    const raw = readFileSync(outFile, "utf-8");
    const response = JSON.parse(raw) as {
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
  } finally {
    // Cleanup temp files — best effort
    try { unlinkSync(bodyFile); } catch {}
    try { unlinkSync(outFile); } catch {}
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
