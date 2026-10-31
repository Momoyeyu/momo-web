import Button from '../ui/Button';
import {useT} from '../i18n';
export default function DialogHandle({onClick,active=true}:{onClick:()=>void;active?:boolean}){
 const t=useT();
 return <Button tabIndex={active?0:-1} aria-hidden={!active} className="dialog-reopen tip" data-tip={t('phone.returnChat')} aria-label={t('phone.returnChat')} onClick={onClick}><svg viewBox="0 0 64 24" width="64" height="24" fill="none" aria-hidden="true"><path d="M12 18 32 7l20 11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/><path d="M24 18l8-4 8 4" stroke="currentColor" strokeOpacity=".35" strokeLinecap="round"/></svg></Button>;
}
