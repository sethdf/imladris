export async function main(worker_results: any[], total_planned: number, dry_run: boolean) {
  const embedded = worker_results.reduce((s, r) => s + (r?.embedded ?? 0), 0);
  const failed   = worker_results.reduce((s, r) => s + (r?.failed ?? 0), 0);
  const chunks   = worker_results.reduce((s, r) => s + (r?.chunks_total ?? 0), 0);
  const allErrors = worker_results.flatMap(r => r?.errors ?? []);

  console.log('━━━ PAI Memory Embed Complete ━━━');
  console.log(`  Planned:  ${total_planned}`);
  console.log(`  Embedded: ${embedded} (${chunks} chunks)`);
  console.log(`  Failed:   ${failed}`);
  if (dry_run) console.log('  (DRY RUN)');
  if (allErrors.length > 0) {
    console.log(`  Errors (first ${allErrors.length}):`);
    allErrors.forEach(e => console.log(`    ${e}`));
  }

  return { embedded, failed, chunks, total_planned, dry_run, errors: allErrors };
}
