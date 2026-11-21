import {useSyncExternalStore} from 'react';
import ProactiveResponseToggle from '../../components/ProactiveResponseToggle';
import {LANGS, resolveChatLang, tFor, useT} from '../../i18n';
import {getState, speakerName, subscribe, update} from '../../lib/store';
import type {GeneralConfig, Lang} from '../../lib/types';
import {useIntro} from '../../services/introClient';
import FieldRow from '../../ui/FieldRow';
import Select from '../../ui/Select';
import Slider from '../../ui/Slider';
import Switch from '../../ui/Switch';
import DialogPreview from './DialogPreview';
import SoundSettings from './SoundSettings';

export default function GeneralTab({section}: {section: 'language' | 'sound' | 'display' | 'preview'}) {
  const t = useT();
  const intro = useIntro();
  const guided = !!intro.data && intro.data.phase !== 'completed';
  const {settings} = useSyncExternalStore(subscribe, getState);
  const general = settings.general;
  const patch = (changes: Partial<GeneralConfig>) => {
    const current = getState().settings;
    update({settings: {...current, general: {...current.general, ...changes}}});
  };
  if (section === 'language') {
    const languages = LANGS.map(value => ({value, label: t('settings.langs.' + value)}));
    return <div className="language-pair">
      <div data-intro="language"><FieldRow label={t('settings.langLabel')}>
        <Select label={t('settings.langLabel')} value={general.lang} options={languages} onChange={v => patch({lang: v as Lang})}/>
      </FieldRow></div>
      <div inert={guided} aria-disabled={guided}><FieldRow label={t('settings.chatLang')}>
        <Select label={t('settings.chatLang')} value={guided ? 'auto' : general.chatLang} options={[{value: 'auto', label: t('settings.langAuto')}, ...languages]}
          onChange={v => patch({chatLang: v as GeneralConfig['chatLang']})}/>
      </FieldRow></div>
    </div>;
  }
  if (section === 'preview') {
    const lang = resolveChatLang(general);
    return <DialogPreview lang={lang} name={speakerName()} sample={tFor(lang, 'settings.previewSample')}
      opacity={general.dialogOpacity} textSpeed={general.textSpeed} sentenceSpeed={general.sentenceSpeed} showStatus={general.showStatus}/>;
  }
  const slider = (key: 'dialogOpacity' | 'textSpeed' | 'sentenceSpeed') => {
    const label = t('settings.' + key);
    return <FieldRow label={label}><Slider label={label} value={general[key]} onChange={v => patch({[key]: v})}/></FieldRow>;
  };
  if (section === 'display') return <>
    {slider('dialogOpacity')}{slider('textSpeed')}{slider('sentenceSpeed')}
    <div className="config-split config-split-stack dialogue-switches">
      <FieldRow label={t('settings.showStatus')}>
        <Switch title={t('settings.showStatus')} on={general.showStatus} onChange={showStatus => patch({showStatus})}/>
      </FieldRow>
      <ProactiveResponseToggle placement="settings"/>
    </div>
  </>;

  return <SoundSettings general={general} tts={settings.tts}/>;
}
