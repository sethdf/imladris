// activepieces_adapter.ts — Run any Activepieces piece action from Windmill
//
// Thin adapter that calls Activepieces piece actions with the minimal
// context they need: { propsValue, auth }. No Activepieces runtime required.
//
// Usage in any Windmill script:
//   import { runAction, listActions } from "../infra/activepieces_adapter.ts";
//   const result = await runAction("@activepieces/piece-slack", "send_channel_message", {
//     auth: { access_token: "xoxb-..." },
//     props: { channel: "#general", text: "Hello from Windmill" }
//   });
//
// To add a new service:
//   1. bun add @activepieces/piece-{name}  (in windmill/ dir)
//   2. Import and call runAction in your Windmill script
//   3. Store auth credentials in BWS → Windmill variables
//   4. Add to integration_registry.ts

interface RunActionParams {
  auth: Record<string, unknown>;    // credentials (api_key, access_token, etc.)
  props: Record<string, unknown>;   // action-specific parameters
}

interface ActionInfo {
  name: string;
  displayName: string;
  description?: string;
  props: string[];
}

/**
 * Run an action from an Activepieces piece.
 *
 * @param piecePackage - npm package name (e.g. "@activepieces/piece-slack")
 * @param actionName - action key (e.g. "send_channel_message")
 * @param params - { auth, props }
 * @returns action result
 */
export async function runAction(
  piecePackage: string,
  actionName: string,
  params: RunActionParams,
): Promise<unknown> {
  // Dynamic import of the piece
  const mod = require(piecePackage);
  const pieceExportName = Object.keys(mod).find(k => typeof mod[k] === "object" && mod[k]?.actions);
  if (!pieceExportName) {
    throw new Error(`No piece found in ${piecePackage}. Exports: ${Object.keys(mod).join(", ")}`);
  }

  const piece = mod[pieceExportName];
  const actions = typeof piece.actions === "function" ? piece.actions() : piece.actions;
  const action = actions[actionName];

  if (!action) {
    throw new Error(
      `Action "${actionName}" not found in ${piecePackage}. Available: ${Object.keys(actions).join(", ")}`
    );
  }

  // Call the action with minimal context
  return await action.run({
    auth: params.auth,
    propsValue: params.props,
    // Provide stub implementations for optional context methods
    // that some pieces may call
    store: {
      put: async () => {},
      get: async () => null,
      delete: async () => {},
    },
    files: {
      write: async () => "",
    },
    server: {
      apiUrl: "",
      publicUrl: "",
      token: "",
    },
    connections: {
      get: async () => null,
    },
  });
}

/**
 * List all actions available in a piece.
 */
export function listActions(piecePackage: string): ActionInfo[] {
  const mod = require(piecePackage);
  const pieceExportName = Object.keys(mod).find(k => typeof mod[k] === "object" && mod[k]?.actions);
  if (!pieceExportName) return [];

  const piece = mod[pieceExportName];
  const actions = typeof piece.actions === "function" ? piece.actions() : piece.actions;

  return Object.entries(actions).map(([name, action]: [string, any]) => ({
    name,
    displayName: action.displayName || name,
    description: action.description,
    props: Object.keys(action.props || {}),
  }));
}

/**
 * List all installed Activepieces pieces.
 */
export function listInstalledPieces(): string[] {
  try {
    const { readdirSync } = require("fs");
    const { join } = require("path");

    // Check node_modules/@activepieces for installed pieces
    const apDir = join(process.cwd(), "node_modules", "@activepieces");
    return readdirSync(apDir)
      .filter((d: string) => d.startsWith("piece-") && d !== "pieces-framework")
      .map((d: string) => `@activepieces/${d}`);
  } catch {
    return [];
  }
}

// ── Windmill script entry point ──
// Can be called directly to explore pieces:
//   action: "list-pieces" — show installed pieces
//   action: "list-actions" — show actions for a piece
//   action: "run" — execute an action

export async function main(
  action: string = "list-pieces",
  piece_package: string = "",
  action_name: string = "",
  auth_json: string = "{}",
  props_json: string = "{}",
) {
  switch (action) {
    case "list-pieces":
      return { pieces: listInstalledPieces() };

    case "list-actions":
      if (!piece_package) return { error: "piece_package is required" };
      return { actions: listActions(piece_package) };

    case "run":
      if (!piece_package || !action_name) {
        return { error: "piece_package and action_name are required" };
      }
      const auth = JSON.parse(auth_json);
      const props = JSON.parse(props_json);
      return await runAction(piece_package, action_name, { auth, props });

    default:
      return { error: `Unknown action: ${action}. Use list-pieces, list-actions, or run.` };
  }
}
