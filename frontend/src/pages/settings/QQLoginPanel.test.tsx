import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it,vi} from 'vitest';
import {zh} from '../../i18n/zh';
import type {QQRuntimeState} from '../../services/qqRuntimeClient';
vi.mock('../../i18n',()=>({useT:()=> (key:string)=>key.split('.').reduce<unknown>((value,part)=>(value as Record<string,unknown>)?.[part],zh)??key}));
import QQLoginPanel from './QQLoginPanel';
const idle:QQRuntimeState={provider:'qq',status:'idle',running:false,connected:false,actualSelfId:null,attemptId:null,error:null,executorQuiescent:true,qr:null};
const render=(runtime:QQRuntimeState|null,busy=false)=>renderToStaticMarkup(createElement(QQLoginPanel,{runtime,error:null,busy,pendingAction:null,onLogin:()=>{},onLogout:()=>{}}));
describe('QQ login exposes only the current lifecycle operation',()=>{
  it('offers neither login nor logout before a reliable status arrives',()=>{
    const html=render(null);expect(html).not.toMatch(/<button[^>]*>登录 QQ<\/button>/);expect(html).not.toContain('>退出登录</button>');
  });
  it('offers generic Login for cached idle, without Logout or QR maintenance controls',()=>{
    const html=render(idle);expect(html).toContain('>登录 QQ</button>');
    for(const label of ['退出登录','刷新二维码','重新扫码','取消登录','保存并启用'])expect(html).not.toContain(`>${label}`);
  });
  it('offers only Logout after native login, without an extra confirmation or enable action',()=>{
    const html=render({...idle,status:'connected',running:true,connected:true,actualSelfId:'123456',executorQuiescent:false});
    expect(html).toContain('>退出登录</button>');expect(html).not.toContain('>登录 QQ</button>');expect(html).not.toContain('qq-login-forget-confirm');expect(html).not.toContain('保存并启用');
  });
  it('keeps pending login observable without refresh, cancel or an enabled duplicate login',()=>{
    const html=render({...idle,status:'verifying',running:true,executorQuiescent:false,attemptId:'attempt-1'});
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>正在登录…<\/button>/);
    for(const label of ['退出登录','刷新二维码','重新扫码','取消登录'])expect(html).not.toContain(`>${label}`);
  });
});
