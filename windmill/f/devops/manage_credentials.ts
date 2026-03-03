// Windmill Script: Manage Credentials (DevOps Tool)
// MCP-accessible credential management for investigation and devops tools.
// Lists, creates, and checks Windmill variables used by investigation scripts.
//
// Actions:
//   list    — List all variables in a folder (default: f/investigate/)
//   check   — Check if a specific variable exists and has a value
//   create  — Create a new secret variable with a placeholder value
//   create_for_tool — Create all variables a tool needs (from its code comments)

import * as wmill from "windmill-client";

export async function main(
  action: "list" | "check" | "create" | "create_for_tool" = "list",
  folder: string = "f/investigate",
  variable_path?: string,
  variable_value?: string,
  variable_description?: string,
) {
  const base = process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
  const token = process.env.WM_TOKEN;
  const workspace = process.env.WM_WORKSPACE || "imladris";

  if (!token) return { error: "WM_TOKEN not available" };

  switch (action) {
    case "list": {
      // List all variables in the specified folder
      const resp = await fetch(
        `${base}/api/w/${workspace}/variables/list`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!resp.ok) {
        return { error: `Failed to list variables: ${resp.status}` };
      }
      const allVars = await resp.json() as Array<{
        path: string;
        value: string;
        is_secret: boolean;
        description: string;
      }>;

      // Filter to the requested folder
      const cleanFolder = folder.replace(/\/$/, "");
      const folderVars = allVars.filter((v) => v.path.startsWith(`${cleanFolder}/`));

      return {
        folder: cleanFolder,
        count: folderVars.length,
        variables: folderVars.map((v) => ({
          path: v.path,
          is_secret: v.is_secret,
          has_value: v.is_secret ? "(secret — hidden)" : (v.value !== "" && v.value !== "PLACEHOLDER"),
          description: v.description || "",
        })),
      };
    }

    case "check": {
      if (!variable_path) {
        return { error: "variable_path is required for check action" };
      }
      try {
        const value = await wmill.getVariable(variable_path);
        const isEmpty = !value || value === "" || value === "PLACEHOLDER";
        return {
          path: variable_path,
          exists: true,
          has_value: !isEmpty,
          note: isEmpty
            ? "Variable exists but has no real value — needs to be populated in BWS and synced"
            : "Variable exists and has a value",
        };
      } catch {
        return {
          path: variable_path,
          exists: false,
          has_value: false,
          note: "Variable does not exist — create it with action=create, then populate in BWS and run sync-credentials.sh",
        };
      }
    }

    case "create": {
      if (!variable_path) {
        return { error: "variable_path is required for create action" };
      }
      const value = variable_value || "PLACEHOLDER";
      const desc = variable_description || "Auto-created credential placeholder";

      try {
        await wmill.setVariable(variable_path, value, true, desc);
        // Derive the BWS key name from the variable path
        // f/investigate/site24x7_access_token → investigate-site24x7-access-token
        // f/devops/sdp_base_url → sdp-base-url
        const parts = variable_path.split("/");
        const varName = parts[parts.length - 1];
        const folderName = parts.length >= 2 ? parts[parts.length - 2] : "";
        const bwsKey = folderName === "investigate"
          ? `investigate-${varName.replace(/_/g, "-")}`
          : varName.replace(/_/g, "-");

        return {
          action: "created",
          path: variable_path,
          bws_key: bwsKey,
          message: `Created secret variable ${variable_path}. To populate: create BWS secret "${bwsKey}" with the actual value, then run sync-credentials.sh`,
        };
      } catch (e) {
        return { error: `Failed to create variable: ${e}` };
      }
    }

    case "create_for_tool": {
      // Look up a script and find its required variables from code comments
      if (!variable_path) {
        return { error: "variable_path should be the script path (e.g., f/investigate/get_monitoring_alerts)" };
      }

      const scriptResp = await fetch(
        `${base}/api/w/${workspace}/scripts/get/p/${variable_path}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!scriptResp.ok) {
        return { error: `Script not found: ${variable_path}` };
      }
      const script = await scriptResp.json() as { content: string };

      // Extract variable paths from getVariable() calls
      const varPattern = /getVariable\s*\(\s*["']([^"']+)["']\s*\)/g;
      const requiredVars: string[] = [];
      let match;
      while ((match = varPattern.exec(script.content)) !== null) {
        requiredVars.push(match[1]);
      }

      if (requiredVars.length === 0) {
        return { message: `Script ${variable_path} does not use any Windmill variables` };
      }

      // Check each variable
      const results = [];
      for (const varPath of requiredVars) {
        try {
          const value = await wmill.getVariable(varPath);
          const isEmpty = !value || value === "" || value === "PLACEHOLDER";
          results.push({
            path: varPath,
            exists: true,
            has_value: !isEmpty,
            status: isEmpty ? "NEEDS_VALUE" : "OK",
          });
        } catch {
          // Create the variable as placeholder
          const parts = varPath.split("/");
          const varName = parts[parts.length - 1];
          const folderName = parts.length >= 2 ? parts[parts.length - 2] : "";
          const bwsKey = folderName === "investigate"
            ? `investigate-${varName.replace(/_/g, "-")}`
            : varName.replace(/_/g, "-");

          try {
            await wmill.setVariable(varPath, "PLACEHOLDER", true, `Required by ${variable_path}`);
            results.push({
              path: varPath,
              exists: false,
              has_value: false,
              status: "CREATED_PLACEHOLDER",
              bws_key: bwsKey,
            });
          } catch (e) {
            results.push({
              path: varPath,
              exists: false,
              has_value: false,
              status: "CREATE_FAILED",
              error: String(e),
            });
          }
        }
      }

      const needsWork = results.filter((r) => r.status !== "OK");
      return {
        script: variable_path,
        total_variables: requiredVars.length,
        ready: results.filter((r) => r.status === "OK").length,
        needs_work: needsWork.length,
        variables: results,
        instructions: needsWork.length > 0
          ? `${needsWork.length} variable(s) need values. Create BWS secrets with the listed bws_key names, populate values, then run sync-credentials.sh`
          : "All variables are populated and ready",
      };
    }
  }
}
