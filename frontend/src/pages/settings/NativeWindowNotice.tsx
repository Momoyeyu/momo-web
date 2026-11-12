import {useT} from '../../i18n';
import Hint from '../../ui/Hint';
import Icon from '../../ui/Icon';
export type NativeWindowDiagnostics={targets:unknown[];screenPermission?:boolean;inputPermission?:boolean};
export default function NativeWindowNotice({result,interact}:{result:NativeWindowDiagnostics|null;interact:boolean}){
 const t=useT();
 if(!result)return null;
 const notices=[
  ...(result.screenPermission===false?['screenPermission']:[]),
  ...(interact&&result.inputPermission===false?['inputPermission']:[]),
  ...(result.targets.length===0?['noWindows']:[]),
 ];
 return <>{notices.map(key=><p key={key} role="status" className="extension-detail-notice">{t('permissions.'+key)} <Hint text={t('permissions.'+key+'Hint')} side="down"/>
  {key!=='noWindows'&&typeof window!=='undefined'&&window.momoDesktop?.requestSystemPermission&&<button type="button" className="icon-btn" aria-label={t('permissions.openSystemSettings')} onClick={()=>void window.momoDesktop!.requestSystemPermission!(key==='inputPermission'?'input':'screen').catch(()=>{})}><Icon name="gear"/></button>}</p>)}</>;
}
