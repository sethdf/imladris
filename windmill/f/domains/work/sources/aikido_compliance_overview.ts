// Windmill Script: Aikido Compliance Overview (Read-Only)
// Investigation tool — returns compliance framework status from Aikido.
// Covers SOC 2, ISO 27001, NIS2 compliance tracking.
//
// Requires: f/investigate/aikido_client_id, f/investigate/aikido_client_secret

import { aikidoFetch } from "./aikido_helper.ts";

export async function main() {
  try {
    const data = await aikidoFetch("/compliance");

    return {
      compliance: data,
    };
  } catch (e) {
    return { error: String(e) };
  }
}
