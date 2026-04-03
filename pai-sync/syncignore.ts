const EXCLUDED_PREFIXES = [
  'PAI/',
  'projects/',
  'MEMORY/STATE/',
  'History/',        // session-level write-through cache, large
  'debug/',          // Claude internal debug files
  'telemetry/',      // Claude telemetry files
];

const EXCLUDED_SUFFIXES = ['.tmp', '.lock'];

// Binary file extensions — not text, can't store as UTF-8
const EXCLUDED_EXTENSIONS = [
  '.woff', '.woff2', '.ttf', '.otf', '.eot',  // fonts
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',  // images
  '.pdf', '.zip', '.gz', '.tar', '.br',  // archives/compressed
  '.mp3', '.mp4', '.wav', '.ogg', '.webm',  // media
];

export function shouldExclude(relativePath: string): boolean {
  for (const prefix of EXCLUDED_PREFIXES) {
    if (relativePath.startsWith(prefix)) return true;
  }
  for (const suffix of EXCLUDED_SUFFIXES) {
    if (relativePath.endsWith(suffix)) return true;
  }
  for (const ext of EXCLUDED_EXTENSIONS) {
    if (relativePath.endsWith(ext)) return true;
  }
  return false;
}
