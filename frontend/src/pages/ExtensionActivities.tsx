import {useState} from 'react';
import {useT} from '../i18n';
import {useActivities} from '../services/extensionActivities';
import Button from '../ui/Button';
import Icon from '../ui/Icon';
import Modal from '../ui/Modal';
import ComputerCompanion from './settings/ComputerCompanion';
import BrowserCompanion from './settings/BrowserCompanion';
import MinecraftCompanion from './settings/MinecraftCompanion';
import '../styles/plugin-library.css';
export default function ExtensionActivities(){
 const t=useT(),enabled=useActivities(),[open,setOpen]=useState(false);
 return <><Button className="tb" title={t('settings.tabs.extend')} aria-label={t('settings.tabs.extend')} onClick={()=>setOpen(true)}><Icon name="plus"/></Button>{open&&<Modal className="extension-modal extension-activities" label={t('settings.tabs.extend')} onClose={()=>setOpen(false)}><div className="extension-modal-heading"><h3>{t('settings.tabs.extend')}</h3><Button variant="ghost" aria-label={t('browser.dismiss')} onClick={()=>setOpen(false)}>×</Button></div><div className="plugin-library-items">{enabled.computer&&<ComputerCompanion/>}{enabled.browser&&<BrowserCompanion/>}{enabled.minecraft&&<MinecraftCompanion/>}{!Object.values(enabled).some(Boolean)&&<p>{t('plugins.empty')}</p>}</div></Modal>}</>;
}
