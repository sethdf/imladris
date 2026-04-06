export async function main(pipeline_status: string, source: string, item_id: string, summary: string) {
  console.log(`Triage complete — no remediation needed`);
  console.log(`  Status:  ${pipeline_status}`);
  console.log(`  Source:  ${source}`);
  console.log(`  Item:    ${item_id}`);
  console.log(`  Summary: ${summary}`);
  return { pipeline_status, source, item_id, summary, remediation: false };
}
