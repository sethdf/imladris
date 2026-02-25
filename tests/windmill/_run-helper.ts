// Test helper: runs a windmill script's main() in a subprocess
// Usage: bun run _run-helper.ts <script-path> <json-args>
// Outputs JSON result to stdout.

const scriptPath = process.argv[2];
const args = JSON.parse(process.argv[3] || '[]');

const mod = await import(scriptPath);
const result = await mod.main(...args);
console.log(JSON.stringify(result));
