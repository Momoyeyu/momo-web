import {afterEach, expect, it, vi} from 'vitest';
import JSZip from 'jszip';
vi.mock('../lib/idb', () => ({allBlobs: vi.fn(), replaceBlobs: vi.fn()}));
vi.mock('./http', () => ({apiFetch: vi.fn()}));
import {allBlobs, replaceBlobs} from '../lib/idb';
import {apiFetch} from './http';
import {exportData, importData} from './dataTransfer';
afterEach(() => vi.resetAllMocks());
async function fixture(): Promise<Blob> {
  const zip = new JSZip();
  const bytes = new TextEncoder().encode('SQLite fixture');
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  zip.file('momo.db', bytes);
  zip.file('manifest.json', JSON.stringify({format:'momo-data',version:1,files:{'momo.db':{size:bytes.length,sha256:digest}}}));
  return zip.generateAsync({type:'blob'});
}
it('round-trips IndexedDB model ZIPs with versioned manifest and hashes', async () => {
  vi.mocked(allBlobs).mockResolvedValue({custom: new Blob(['model zip bytes']), 'custom:thumb': new Blob(['derived thumbnail'])});
  vi.mocked(apiFetch).mockResolvedValue(new Response(await fixture()));
  const backup = await exportData();
  const archive = await JSZip.loadAsync(await backup.arrayBuffer());
  expect(await archive.file('avatars/custom.zip')!.async('text')).toBe('model zip bytes');
  // The backend accepts only manifest-listed files, including no generated directories.
  expect(Object.keys(archive.files).sort()).toEqual(['avatars/custom.zip', 'manifest.json', 'momo.db']);
  const manifest = JSON.parse(await archive.file('manifest.json')!.async('text'));
  expect(manifest.files['avatars/custom.zip'].sha256).toHaveLength(64);
  expect(Object.keys(manifest.files)).toEqual(['momo.db', 'avatars/custom.zip']);
  vi.mocked(apiFetch).mockResolvedValue(new Response('{}'));
  await importData(new File([backup], 'backup.zip'));
  const restored = vi.mocked(replaceBlobs).mock.calls[0][0];
  expect(await restored.custom.text()).toBe('model zip bytes');
});
it('restores prior model transaction if backend import fails', async () => {
  const previous = {previous: new Blob(['old']), 'previous:thumb': new Blob(['old thumbnail'])};
  vi.mocked(allBlobs).mockResolvedValue(previous);
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response('{}')).mockRejectedValueOnce(new Error('Import failed'));
  const data = await fixture();
  await expect(importData(new File([data], 'backup.zip'))).rejects.toThrow('Import failed');
  expect(replaceBlobs).toHaveBeenLastCalledWith(previous);
});
it('does not open or change browser model storage after server validation rejection', async () => {
  vi.mocked(apiFetch).mockRejectedValue(new Error('Invalid archive'));
  await expect(importData(new File(['invalid'], 'backup.zip'))).rejects.toThrow('Invalid archive');
  expect(allBlobs).not.toHaveBeenCalled();
  expect(replaceBlobs).not.toHaveBeenCalled();
});
