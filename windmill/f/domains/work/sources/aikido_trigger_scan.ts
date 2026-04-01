// Windmill Script: Aikido Trigger Scan (Write Operation)
// DevOps tool — triggers a security scan on a code repository in Aikido.
//
// Requires: f/investigate/aikido_client_id, f/investigate/aikido_client_secret

import { aikidoFetch } from "./aikido_helper.ts";

export async function main(
  repo_id: string,
) {
  if (!repo_id) {
    return { error: "repo_id is required — use aikido_list_repos to find repository IDs" };
  }

  try {
    const data = await aikidoFetch(`/repositories/code/${repo_id}/scan`, {
      method: "POST",
    });

    return {
      action: "scan_triggered",
      repo_id,
      response: data,
      message: `Scan triggered for repository ${repo_id}. Check Aikido dashboard for results.`,
    };
  } catch (e) {
    return { error: String(e) };
  }
}
