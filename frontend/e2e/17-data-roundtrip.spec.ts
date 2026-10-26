import {test, expect} from './fixtures';
import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import JSZip from 'jszip';
import {presentation} from './helpers/runtime';
import {bootChat,openTab, readState, writeState, settle} from './helpers';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function publicModelZip(): Promise<Buffer> {
  const zip = new JSZip(), root = resolve('public/live2d/hiyori');
  async function add(directory: string, relative = '') {
    for (const entry of await readdir(directory, {withFileTypes:true})) {
      const name = relative + entry.name, path = join(directory,entry.name);
      if (entry.isDirectory()) await add(path,name+'/');
      else zip.file(name,await readFile(path));
    }
  }
  await add(root); return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
async function blobs(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const {allBlobs} = await import('/src/lib/idb.ts');
    const result: Record<string,string> = {};
    for (const [key,blob] of Object.entries(await allBlobs())) {
      const digest = await crypto.subtle.digest('SHA-256',await (blob as Blob).arrayBuffer());
      result[key]=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
    }
    return result;
  });
}

test('backup round-trips imported model ZIP, YAML and SQLite through actual controls', async ({page,request}, info) => {
  test.setTimeout(120_000);
  const model = await publicModelZip();
  await openTab(page,'拓展');
  await page.getByRole('button',{name:'导入模型',exact:true}).click();
  await page.locator('input[type=file][accept=".zip,application/zip"]').setInputFiles({name:'public-Hiyori.zip',mimeType:'application/zip',buffer:model});
  await expect.poll(async () => (await readState(request)).avatarId).not.toBe('builtin');
  const id = String((await readState(request)).avatarId);
  await expect.poll(async () => (await blobs(page))[id]).toBe(sha(model));
  await expect.poll(async () => Boolean((await blobs(page))[id+':thumb'])).toBe(true);
  await expect.poll(async () => (await presentation(page))?.avatarId).toBe(id);
  await page.evaluate(async()=>{
    const entry=performance.getEntriesByType('resource').find(item=>new URL(item.name).pathname==='/src/lib/store.ts')!;
    const store=await import(entry.name);
    const state=store.getState();
    store.update({settings:{...state.settings,llm:{...state.settings.llm,key:'synthetic-backup-marker'}}});
  });
  const savedMemory = await (await request.post('/api/memories',{data:{content:'three-store preserved memory'}})).json();
  await page.getByRole('button',{name:'通用',exact:true}).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button',{name:'导出备份',exact:true}).click();
  const file = await download;
  const path = info.outputPath('synthetic-backup.zip'); await file.saveAs(path);
  const archive = await JSZip.loadAsync(await readFile(path));
  const manifest = JSON.parse(await archive.file('manifest.json')!.async('string'));
  expect(Object.keys(manifest.files).filter(name=>name.startsWith('avatars/'))).toEqual([`avatars/${id}.zip`]);
  expect(sha(await archive.file(`avatars/${id}.zip`)!.async('nodebuffer'))).toBe(sha(model));
  expect(await archive.file('momo.yaml')!.async('string')).toContain('synthetic-backup-marker');
  expect((await archive.file('momo.db')!.async('nodebuffer')).subarray(0,16).toString()).toBe('SQLite format 3\0');
  await page.evaluate(async () => (await import('/src/lib/idb.ts')).replaceBlobs({}));
  const changed = await readState(request) as any; changed.settings.llm.key='after-export'; changed.avatarId='builtin'; changed.avatars=changed.avatars.filter((a:any)=>a.id==='builtin');
  await writeState(request,changed); await request.delete(`/api/memories/${savedMemory.id}`);
  const after = await (await request.post('/api/memories',{data:{content:'discard post-export mutation'}})).json();
  // Keep a genuine boot-time PUT in flight while Restore is pressed.
  // The request still reaches the isolated backend; only network scheduling is delayed.
  await page.route('**/api/state',async route=>{
    if(route.request().method()==='PUT') await new Promise(resolve=>setTimeout(resolve,500));
    await route.continue();
  });
  const pendingPut=page.waitForRequest(req=>new URL(req.url()).pathname==='/api/state' && req.method()==='PUT');
  await page.reload(); await openTab(page,'通用'); await pendingPut;
  page.once('dialog',dialog=>void dialog.accept());
  await page.locator('input[type=file][accept=".zip"]').setInputFiles(path);
  await expect.poll(async () => ((await readState(request)) as any).settings.llm.key).toBe('synthetic-backup-marker');
  await expect.poll(async () => (await blobs(page))[id]).toBe(sha(model));
  const restored = await (await request.get('/api/memories')).json();
  expect(restored.some((m:any)=>m.id===savedMemory.id && m.content==='three-store preserved memory')).toBe(true);
  expect(restored.some((m:any)=>m.id===after.id)).toBe(false);
  await bootChat(page);
  await expect(page.locator('.chat-page')).toBeVisible();
  await settle(page);
  await expect.poll(async () => (await presentation(page))?.avatarId).toBe(id);
  expect(await page.evaluate(async () => {
    const entry=performance.getEntriesByType('resource').find(item=>new URL(item.name).pathname==='/src/live2d/stage.ts')!;
    const stage=(await import(entry.name)).getStage();
    return stage.model.visible && stage.model.internalModel.coreModel.getDrawableCount()>0;
  })).toBe(true);
  // Let boot/calibration autosave and the deliberately delayed PUT finish too.
  await page.waitForTimeout(1500);
  expect(((await readState(request)) as any).settings.llm.key).toBe('synthetic-backup-marker');
  expect((await readState(request)).avatarId).toBe(id);
  await page.screenshot({path:info.outputPath('restored-imported-model.png')});
});
