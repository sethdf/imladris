// Windmill Script: Aikido Export SBOM (Read Operation via DevOps)
// DevOps tool — exports Software Bill of Materials for a code repository.
// Placed in devops/ as it generates artifacts, though technically read-only.
//
// Requires: f/investigate/aikido_client_id, f/investigate/aikido_client_secret

import { aikidoFetch } from "../investigate/aikido_helper.ts";

export async function main(
  repo_id: string,
) {
  if (!repo_id) {
    return { error: "repo_id is required — use aikido_list_repos to find repository IDs" };
  }

  try {
    const data = await aikidoFetch(`/repositories/code/${repo_id}/sbom`);

    return {
      repo_id,
      sbom: data,
      format: "CycloneDX",
      message: `SBOM exported for repository ${repo_id}`,
    };
  } catch (e) {
    return { error: String(e) };
  }
}
