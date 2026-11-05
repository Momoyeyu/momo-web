import {it,expect} from 'vitest';
import {MusicDirector} from './director';
it('keeps music across subpages; chooses night and intro deterministically',()=>{
 const chosen:string[]=[];const d=new MusicDirector(id=>chosen.push(id),()=>0,()=>23);
 d.page('chat',false);d.page('settings',false);d.page('chat',false);expect(chosen).toEqual(['night']);
 d.page('chat',true);expect(chosen.at(-1)).toBe('connection');d.page('title',false);expect(chosen.at(-1)).toBe('title');
});
it('requires two distinct consistent dialogue turns and minimum residence',()=>{
 const chosen:string[]=[];let now=0;const d=new MusicDirector(id=>chosen.push(id),()=>now,()=>12);d.page('chat',false);
 d.cue('bright','a');d.cue('bright','a');expect(chosen).toEqual(['daily']);d.cue('bright','b');expect(chosen).toEqual(['daily']);now=61000;d.cue('bright','c');expect(chosen.at(-1)).toBe('uplift');
 d.cue('neutral','d');d.cue('bright','e');now=122000;d.cue('neutral','f');expect(chosen.at(-1)).toBe('uplift');d.cue('neutral','g');expect(chosen.at(-1)).toBe('daily');
});
it('serious comfort overrides bright music without letting remote/unknown cues act',()=>{
 const chosen:string[]=[];const d=new MusicDirector(id=>chosen.push(id),()=>70000,()=>12);d.page('chat',false);d.cue('https://evil.example/music','x');d.cue('comfort','a');expect(chosen).toEqual(['daily','comfort']);d.page('settings',false);d.cue('bright','b');d.cue('bright','c');expect(chosen.at(-1)).toBe('comfort');
});
