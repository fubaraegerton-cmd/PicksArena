import { EMPTY_DATA, type AdminData } from '../src/shared/admin.js';

/**
 * Persistence for admin data.
 * - Production (Vercel): Vercel Blob. Each save writes a new immutable JSON file under `admin/`
 *   and readers take the newest, so CDN caching never serves stale data. Old versions are pruned.
 * - Local dev (no BLOB_READ_WRITE_TOKEN): a JSON file in .data/.
 */

const PREFIX = 'admin/data-';
const KEEP = 5;

export function storageMode(): 'blob' | 'file' | 'none' {
  if (process.env.BLOB_READ_WRITE_TOKEN) return 'blob';
  if (process.env.VERCEL) return 'none';
  return 'file';
}

export async function loadData(): Promise<AdminData> {
  const mode = storageMode();
  if (mode === 'blob') {
    const { list } = await import('@vercel/blob');
    const { blobs } = await list({ prefix: PREFIX, limit: 100 });
    if (blobs.length === 0) return EMPTY_DATA;
    const newest = [...blobs].sort((a, b) => +new Date(b.uploadedAt) - +new Date(a.uploadedAt))[0];
    const res = await fetch(newest.url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Blob read failed: ${res.status}`);
    return (await res.json()) as AdminData;
  }
  if (mode === 'file') {
    const { readFile } = await import('node:fs/promises');
    try {
      return JSON.parse(await readFile(filePath(), 'utf8')) as AdminData;
    } catch {
      return EMPTY_DATA;
    }
  }
  return EMPTY_DATA;
}

export async function saveData(data: AdminData): Promise<void> {
  const mode = storageMode();
  const body = JSON.stringify(data);
  if (mode === 'blob') {
    const { put, list, del } = await import('@vercel/blob');
    const stamp = String(data.updatedAt).padStart(15, '0');
    await put(`${PREFIX}${stamp}.json`, body, {
      access: 'public',
      addRandomSuffix: true,
      contentType: 'application/json',
    });
    const { blobs } = await list({ prefix: PREFIX, limit: 100 });
    const old = [...blobs]
      .sort((a, b) => +new Date(b.uploadedAt) - +new Date(a.uploadedAt))
      .slice(KEEP)
      .map((b) => b.url);
    if (old.length) await del(old);
    return;
  }
  if (mode === 'file') {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const path = filePath();
    await mkdir(path.replace(/[^/]+$/, ''), { recursive: true });
    await writeFile(path, body);
    return;
  }
  throw new Error('Storage is not configured. Connect a Vercel Blob store to this project.');
}

function filePath() {
  return `${process.cwd()}/.data/admin.json`;
}
