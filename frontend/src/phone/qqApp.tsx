import QQPhoneView from './QQPhoneView';
import {registerPhoneApp} from './registry';
// The official plugin supplies its tile and view, not the phone shell.
registerPhoneApp({id:'momo-qq',source:'qq',icon:<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 7c-8 0-12 7-11 17l-4 9 6-2 1 8 8-2 8 2 1-8 6 2-4-9C36 14 32 7 24 7Z" fill="currentColor"/><ellipse cx="24" cy="25" rx="8" ry="10" fill="var(--bg)"/><circle cx="21" cy="17" r="1.4" fill="var(--bg)"/><circle cx="27" cy="17" r="1.4" fill="var(--bg)"/></svg>,render:props=><QQPhoneView {...props}/>});
