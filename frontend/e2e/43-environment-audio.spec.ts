import {test,expect} from './fixtures';
for(const lang of ['zh','en','ja'])test(`environment audio controls ${lang}`,async({page,request},info)=>{
 await page.setViewportSize({width:1280,height:720});
 const state=await(await request.get('/api/state')).json();state.settings.general.lang=lang;
 await request.put('/api/state',{data:state});
 await page.goto('/#/settings');
 const label={zh:'环境声音',en:'Environment audio',ja:'環境オーディオ'}[lang]!;
 await page.getByRole('button',{name:label,exact:true}).click();
 const dialog=page.getByRole('dialog',{name:label});await expect(dialog).toBeVisible();
 const sliders=dialog.locator('input[type=range]');await expect(sliders).toHaveCount(2);
 await sliders.nth(0).fill('0');await sliders.nth(1).fill('0');
 await page.screenshot({path:info.outputPath('audio-settings.png')});
 const b=await dialog.boundingBox();expect(b!.y).toBeGreaterThan(0);expect(b!.y+b!.height).toBeLessThan(720);
 await expect.poll(async()=>{const s=await(await request.get('/api/state')).json();return [s.settings.general.sfxVolume,s.settings.general.musicVolume];}).toEqual([0,0]);
 await page.reload();await page.getByRole('button',{name:label,exact:true}).click();await expect(page.getByRole('dialog').locator('input[type=range]').first()).toHaveValue('0');
});
test('original audio assets decode and loop in real Web Audio',async({page})=>{
 await page.goto('/#/title');
 const result=await page.evaluate(async()=>{
  const c=new AudioContext();const manifest=await(await fetch('/audio/manifest.json')).json();const results=[];
  for(const track of Object.values(manifest.music) as {file:string;frames:number;sampleRate:number}[]){const b=await c.decodeAudioData(await(await fetch('/audio/'+track.file)).arrayBuffer());const source=c.createBufferSource();source.buffer=b;source.loop=true;source.connect(c.destination);results.push({duration:b.duration,expected:track.frames/track.sampleRate,channels:b.numberOfChannels});}
  await c.close();return results;
 });
 expect(result).toHaveLength(6);for(const r of result){expect(Math.abs(r.duration-r.expected)).toBeLessThan(.001);expect(r.channels).toBe(2);}
});
