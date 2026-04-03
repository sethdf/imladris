import { promisify } from 'util';
import { gzip, gunzip } from 'zlib';

const gzipAsync  = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const COMPRESS_THRESHOLD = 100 * 1024; // 100 KB

export function shouldCompress(content: string): boolean {
  return Buffer.byteLength(content, 'utf8') > COMPRESS_THRESHOLD;
}

export async function compress(content: string): Promise<string> {
  const buf = await gzipAsync(Buffer.from(content, 'utf8'));
  return buf.toString('base64');
}

export async function decompress(compressed: string): Promise<string> {
  const buf = await gunzipAsync(Buffer.from(compressed, 'base64'));
  return buf.toString('utf8');
}
