import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
import {zh} from '../../i18n/zh';
vi.mock('../../i18n',()=>({useT:()=> (key:string)=>key.split('.').reduce<unknown>((value,part)=>(value as Record<string,unknown>)?.[part],zh)??key}));
import NativeWindowNotice from './NativeWindowNotice';
const render=(result: Parameters<typeof NativeWindowNotice>[0]['result'],interact=false)=>renderToStaticMarkup(createElement(NativeWindowNotice,{result,interact}));
it('is silent before lookup and for permitted nonempty results',()=>{
 expect(render(null)).toBe('');expect(render({targets:[{}],screenPermission:true,inputPermission:true})).toBe('');
 expect(render({targets:[{}]})).toBe('');
});
it('reports explicit screen denial without adding a permission action',()=>{
 const html=render({targets:[{}],screenPermission:false,inputPermission:false});
 expect(html).toContain('需要屏幕录制权限');expect(html).not.toContain('需要辅助功能权限');expect(html).not.toContain('<button');
 expect(html).toContain('data-tip=');
});
it('requests input diagnostic only for interaction and explains empty fullscreen Space',()=>{
 const html=render({targets:[],screenPermission:true,inputPermission:false},true);
 expect(html).toContain('需要辅助功能权限');expect(html).toContain('当前没有可选窗口');expect(html).toContain('全屏');expect(html).not.toContain('需要屏幕录制权限');
});
it('does not infer denial from an empty result with unknown permission flags',()=>{
 const html=render({targets:[]});expect(html).toContain('当前没有可选窗口');expect(html).not.toContain('需要屏幕录制权限');
});
