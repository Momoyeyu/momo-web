import JSZip from 'jszip';
import {allBlobs, replaceBlobs} from '../lib/idb';
import {apiFetch} from './http';
const LIMIT = 512 * 1024 * 1024;
type Manifest = {format: string; version: number; files: Record<string, {size: number; sha256: string}>};
async function hash(data: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('');
}
export async function exportData(): Promise<Blob> {
  const response = await apiFetch('/api/data/export');
  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  const manifest: Manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
  for (const [id, blob] of Object.entries(await allBlobs())) {
    // Thumbnails are derived previews, while only original ZIPs are portable models.
    if (id.endsWith(':thumb')) continue;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid model identifier');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const name = `avatars/${id}.zip`;
    zip.file(name, bytes, {createFolders: false});
    manifest.files[name] = {size: bytes.length, sha256: await hash(bytes)};
  }
  if (Object.values(manifest.files).reduce((n, f) => n + f.size, 0) > LIMIT) throw new Error('Archive exceeds size limit');
  zip.file('manifest.json', JSON.stringify(manifest));
  return zip.generateAsync({type: 'blob', compression: 'DEFLATE'});
}
export async function importData(file: File): Promise<void> {
  if (file.size > LIMIT) throw new Error('Archive exceeds size limit');
  await apiFetch('/api/data/validate', {method: 'POST', body: file});
  const zip = await JSZip.loadAsync(file);
  const metadata = zip.file('manifest.json');
  if (!metadata) throw new Error('Missing archive manifest');
  const manifest: Manifest = JSON.parse(await metadata.async('string'));
  const names = Object.keys(zip.files).filter(name => !zip.files[name].dir && name !== 'manifest.json');
  if (manifest.format !== 'momo-data' || manifest.version !== 1 || names.length > 2048 || names.length !== Object.keys(manifest.files).length || Object.values(manifest.files).reduce((n, f) => n + f.size, 0) > LIMIT)
    throw new Error('Unsupported archive');
  const models: Record<string, Blob> = {};
  for (const name of names) {
    const expected = manifest.files[name];
    if (!expected || name.includes('..') || name.includes('\\') || name.startsWith('/') || !Number.isSafeInteger(expected.size) || expected.size < 0 || expected.size > LIMIT)
      throw new Error('Invalid archive path');
    const bytes = new Uint8Array(await zip.file(name)!.async('uint8array'));
    if (bytes.length !== expected.size || await hash(bytes) !== expected.sha256) throw new Error('Archive integrity check failed');
    if (name.startsWith('avatars/')) {
      const match = /^avatars\/([a-zA-Z0-9_-]{1,128})\.zip$/.exec(name);
      if (!match) throw new Error('Invalid model identifier');
      models[match[1]] = new Blob([bytes]);
    }
  }
  // IDB commits first; backend stages and rolls back independently on failure.
  const previous = await allBlobs();
  await replaceBlobs(models);
  try { await apiFetch('/api/data/import', {method: 'POST', body: file}); }
  catch (error) { await replaceBlobs(previous); throw error; }
}
