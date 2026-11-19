import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({computer:false,browser:false,minecraft:false,native:false}));
vi.mock('../i18n',()=>({useT:()=> (key:string)=>key}));
vi.mock('../services/extensionActivities',()=>({useActivities:()=>state}));
vi.mock('../services/desktopWindow',()=>({desktopWindowAvailable:()=>state.native,setDesktopMode:vi.fn()}));
import ExtensionActivities from './ExtensionActivities';
const render=()=>renderToStaticMarkup(createElement(ExtensionActivities));
it('offers the enabled game directly without requiring the desktop plugin or native pet window',()=>{
 state.computer=false;state.minecraft=true;state.native=false;
 const html=render();expect(html).toContain('aria-label="minecraft.title"');expect(html).toContain('aria-haspopup="dialog"');
 expect(html).not.toContain('aria-label="desktop.enter"');
});
it('keeps the desktop entry independent and omits disabled games',()=>{
 state.computer=true;state.minecraft=false;state.native=true;
 expect(render()).toContain('aria-label="desktop.enter"');expect(render()).not.toContain('aria-label="minecraft.title"');
 state.computer=false;expect(render()).toContain('aria-label="desktop.enter"');
 state.native=false;expect(render()).toBe('');
});
