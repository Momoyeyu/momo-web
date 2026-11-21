import {test,expect} from './fixtures';
import {useStateRestore} from './helpers';
test.afterEach(useStateRestore());
for(const lang of ['zh','en','ja'])test(`environment audio controls ${lang}`,async({page,request},info)=>{
 await page.setViewportSize({width:1280,height:720});
 const state=await(await request.get('/api/state')).json();Object.assign(state.settings.general,{lang,voiceVolume:71,sfxVolume:43,musicVolume:29,voiceMuted:false,sfxMuted:false,musicMuted:false});
 await request.put('/api/state',{data:state});
 await page.goto('/#/settings');
 await page.locator('[data-intro=tab-sound]').click();
 const panel=page.locator('#config-sound');
 await expect.poll(()=>panel.evaluate(el=>Math.abs(el.getBoundingClientRect().top-el.parentElement!.getBoundingClientRect().top-24))).toBeLessThan(2);
 await expect(panel).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);
 const sliders=panel.locator('input[type=range]');await expect(sliders).toHaveCount(3);
 await expect(panel.getByRole('switch')).toHaveCount(0);
 const mute=panel.locator('button[aria-pressed]');
 await expect(mute).toHaveCount(3);
 for(const button of await mute.all())await button.click();
 for(const [index,volume] of ['71','43','29'].entries()){
  const slider=sliders.nth(index);
  await expect(slider).toBeDisabled();
  await expect(slider).toHaveValue(volume);
  await expect(slider).toHaveCSS('opacity','0.4');
  await expect(panel.locator('.slider-val').nth(index)).toHaveText(volume+'%');
 }
 const saved=async()=> (await(await request.get('/api/state')).json()).settings.general;
 await expect.poll(saved).toMatchObject({voiceVolume:71,sfxVolume:43,musicVolume:29,voiceMuted:true,sfxMuted:true,musicMuted:true});
 await page.screenshot({path:info.outputPath('audio-settings-muted.png')});
 await page.reload();
 await expect(mute.first()).toHaveAttribute('aria-pressed','true');
 await expect(sliders.first()).toHaveValue('71');
 for(const button of await mute.all())await button.click();
 for(const [index,volume] of ['71','43','29'].entries()){
  await expect(sliders.nth(index)).toBeEnabled();
  await expect(sliders.nth(index)).toHaveValue(volume);
 }
 await expect.poll(saved).toMatchObject({voiceMuted:false,sfxMuted:false,musicMuted:false});

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
