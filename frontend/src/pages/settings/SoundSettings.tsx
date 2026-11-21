import {useEffect, useRef, useState} from 'react';
import {ambient} from '../../audio/ambient';
import {useT} from '../../i18n';
import {ttsConfigured} from '../../lib/asr';
import {updateGeneral} from '../../lib/store';
import type {Settings} from '../../lib/types';
import {auditionVoice} from '../../services/ttsWarmup';
import FieldRow from '../../ui/FieldRow';
import IconButton from '../../ui/IconButton';
import Slider from '../../ui/Slider';

const channels = [
  {id:'voice', volume:'voiceVolume', mute:'voiceMuted', fallback:100},
  {id:'sfx', volume:'sfxVolume', mute:'sfxMuted', fallback:35},
  {id:'music', volume:'musicVolume', mute:'musicMuted', fallback:22},
] as const;
type Channel = (typeof channels)[number];

export default function SoundSettings({general, tts}: Pick<Settings, 'general' | 'tts'>) {
  const t = useT();
  const [playing, setPlaying] = useState<Channel['id']>();
  const [failed, setFailed] = useState(false);
  const preview = useRef<{channel: Channel; controller: AbortController} | null>(null);
  const voiceReady = ttsConfigured(tts);

  useEffect(() => () => {
    preview.current?.controller.abort();
    preview.current = null;
  }, []);
  useEffect(() => {
    const current = preview.current;
    if (current && (general[current.channel.mute] || general[current.channel.volume] === 0)) {
      current.controller.abort();
    }
  }, [general]);

  async function play(channel: Channel) {
    const current = preview.current;
    current?.controller.abort();
    if (current?.channel === channel) {
      preview.current = null;
      setPlaying(undefined);
      return;
    }
    const controller = new AbortController();
    preview.current = {channel, controller};
    setPlaying(channel.id);
    setFailed(false);
    try {
      if (channel.id === 'voice') {
        const result = await auditionVoice(controller.signal);
        if (!result.ok && !controller.signal.aborted) setFailed(true);
      } else {
        await ambient.preview(channel.id, controller.signal);
      }
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (preview.current?.controller === controller) {
        preview.current = null;
        setPlaying(undefined);
      }
    }
  }

  return <>
    {channels.map(channel => {
      const label = t('settings.' + channel.volume);
      const muted = general[channel.mute] === true;
      const volume = general[channel.volume] ?? channel.fallback;
      const previewLabel = t(playing === channel.id ? 'settings.audioStop' : 'settings.audioPlay', {channel:label});
      const muteLabel = t('settings.audioMute', {channel:label});
      return <FieldRow key={channel.id} label={label} hint={channel.id === 'voice' && !voiceReady ? t('settings.voiceNeedTts') : undefined}>
        <Slider label={label} value={volume} disabled={muted}
          onChange={value => updateGeneral({[channel.volume]:value})}/>
        <IconButton icon={playing === channel.id ? 'stop' : 'play'} label={previewLabel} tip={previewLabel}
          disabled={muted || volume === 0 || (channel.id === 'voice' && !voiceReady)} onClick={() => void play(channel)}/>
        <IconButton icon={muted ? 'voiceOff' : 'voice'} active={muted} label={muteLabel}
          tip={muted ? t('settings.audioUnmute', {channel:label}) : muteLabel}
          onClick={() => {
            if (!muted && preview.current?.channel === channel) preview.current.controller.abort();
            updateGeneral({[channel.mute]:!muted});
          }}/>
      </FieldRow>;
    })}
    {failed && <p role="alert" className="config-value">{t('settings.audioPreviewError')}</p>}
  </>;
}
