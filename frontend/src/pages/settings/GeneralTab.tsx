import {useState, useSyncExternalStore} from 'react';
import {ambient} from '../../audio/ambient';
import Button from '../../ui/Button';
import {getChatEngine} from '../../chat/engineInstance';
import {LANGS, resolveChatLang, tFor, useT} from '../../i18n';
import {ttsConfigured} from '../../lib/asr';
import {getState, speakerName, subscribe, update} from '../../lib/store';
import type {GeneralConfig, Lang} from '../../lib/types';
import {useIntro} from '../../services/introClient';
import FieldRow from '../../ui/FieldRow';
import Select from '../../ui/Select';
import Slider from '../../ui/Slider';
import Switch from '../../ui/Switch';
import DialogPreview from './DialogPreview';

export default function GeneralTab({section}: {section: 'language' | 'sound' | 'display' | 'preview' | 'sample'}) {
  const t = useT();
  const intro = useIntro();
  const [sample, setSample] = useState<'tap' | 'confirm' | 'cancel'>('tap');
  const guided = !!intro.data && intro.data.phase !== 'completed';
  const {settings} = useSyncExternalStore(subscribe, getState);
  const general = settings.general;
  const patch = (changes: Partial<GeneralConfig>) => {
    const current = getState().settings;
    update({settings: {...current, general: {...current.general, ...changes}}});
  };
  if (section === 'language') {
    const languages = LANGS.map(value => ({value, label: t('settings.langs.' + value)}));
    return <>
      <div data-intro="language"><FieldRow label={t('settings.langLabel')}>
        <Select label={t('settings.langLabel')} value={general.lang} options={languages} onChange={v => patch({lang: v as Lang})}/>
      </FieldRow></div>
      <div inert={guided} aria-disabled={guided}><FieldRow label={t('settings.chatLang')}>
        <Select label={t('settings.chatLang')} value={guided ? 'auto' : general.chatLang} options={[{value: 'auto', label: t('settings.langAuto')}, ...languages]}
          onChange={v => patch({chatLang: v as GeneralConfig['chatLang']})}/>
      </FieldRow></div>
    </>;
  }
  if (section === 'preview') {
    const lang = resolveChatLang(general);
    return <DialogPreview lang={lang} name={speakerName()} sample={tFor(lang, 'settings.previewSample')}
      opacity={general.dialogOpacity} textSpeed={general.textSpeed} sentenceSpeed={general.sentenceSpeed} showStatus={general.showStatus}/>;
  }
  const slider = (key: 'dialogOpacity' | 'textSpeed' | 'sentenceSpeed' | 'voiceVolume' | 'sfxVolume' | 'musicVolume', disabled = false) => {
    const label = t('settings.' + key);
    return <FieldRow label={label}><Slider label={label} value={general[key] ?? (key === 'sfxVolume' ? 35 : 22)} disabled={disabled} onChange={v => patch({[key]: v})}/></FieldRow>;
  };
  if (section === 'display') return <>
    {slider('dialogOpacity')}{slider('textSpeed')}{slider('sentenceSpeed')}
    <FieldRow label={t('settings.showStatus')}><Switch title={t('settings.showStatus')} on={general.showStatus} onChange={showStatus => patch({showStatus})}/></FieldRow>
  </>;

  const palette = (
    <FieldRow label={t('settings.soundPalette')}>
      <Select label={t('settings.soundPalette')} value={general.soundPalette ?? 'warm'} options={[
        {value: 'warm', label: t('settings.soundWarm')}, {value: 'glass', label: t('settings.soundGlass')},
      ]} onChange={v => patch({soundPalette: v as GeneralConfig['soundPalette']})}/>
    </FieldRow>
  );
  if (section === 'sample') return <>
    {palette}
    <FieldRow label={t('config.soundAction')}>
      <Select label={t('config.soundAction')} value={sample} options={[
        {value:'tap', label:t('config.soundTap')}, {value:'confirm', label:t('config.soundConfirm')}, {value:'cancel', label:t('config.soundCancel')},
      ]} onChange={v => setSample(v as typeof sample)}/>
    </FieldRow>
    <footer className="modal-foot"><Button className="config-action" sound={false} disabled={general.sfxVolume === 0} onClick={() => ambient.sound(sample)}>{t('config.soundPlay')}</Button></footer>
  </>;
  const voiceReady = ttsConfigured(settings.tts);
  const voiceOn = voiceReady && !general.voiceMuted;
  return <>
    <FieldRow label={t('settings.voiceInput')}><Switch title={t('settings.voiceInput')} on={general.voiceInput} onChange={voiceInput => {
      patch({voiceInput});
      if (!voiceInput) getChatEngine().stopListening();
    }}/></FieldRow>
    <FieldRow label={t('settings.voiceOut')} hint={!voiceReady ? t('settings.voiceNeedTts') : undefined}>
      <Switch title={t('settings.voiceOut')} on={voiceOn} disabled={!voiceReady} onChange={v => getChatEngine().setMuted(!v)}/>
    </FieldRow>
    {slider('voiceVolume', !voiceOn)}{slider('sfxVolume')}{slider('musicVolume')}
    {palette}
  </>;
}
