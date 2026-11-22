import {useEffect, useRef, useState} from 'react';
import {ambient} from '../../audio/ambient';
import {useT} from '../../i18n';
import {ttsConfigured} from '../../lib/asr';
import {ServiceError} from '../../lib/errors';
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
  const [failure, setFailure] = useState<{channel: Channel['id']; key: string}>();
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
    setFailure(undefined);
    try {
      if (channel.id === 'voice') {
        const result = await auditionVoice(controller.signal);
        if (!result.ok && !controller.signal.aborted) setFailure({channel:channel.id,key:'settings.voiceNeedTts'});
      } else {
        await ambient.preview(channel.id, controller.signal);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const key = error instanceof ServiceError && (error.failure === 'unreachable' || error.detail?.startsWith('TTS 连接失败'))
          ? 'config.unreachable'
          : error instanceof DOMException && error.name === 'TimeoutError' ? 'config.timeout' : 'settings.audioPreviewError';
        setFailure({channel:channel.id,key});
      }
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
      const failed = failure?.channel === channel.id ? t(failure.key) : undefined;
      const muteLabel = t('settings.audioMute', {channel:label});
      return <FieldRow key={channel.id} label={label} hint={channel.id === 'voice' && !voiceReady ? t('settings.voiceNeedTts') : undefined}>
        <Slider label={label} value={volume} disabled={muted}
          onChange={value => updateGeneral({[channel.volume]:value})}/>
        <IconButton icon={playing === channel.id ? 'stop' : failed ? 'close' : 'play'} label={previewLabel}
          className={failed ? 'audio-preview-failed' : undefined} tip={failed ?? previewLabel}
          disabled={muted || volume === 0 || (channel.id === 'voice' && !voiceReady)} onClick={() => void play(channel)}/>
        <IconButton icon={muted ? 'voiceOff' : 'voice'} active={muted} label={muteLabel}
          tip={muted ? t('settings.audioUnmute', {channel:label}) : muteLabel}
          onClick={() => {
            if (!muted && preview.current?.channel === channel) preview.current.controller.abort();
            updateGeneral({[channel.mute]:!muted});
          }}/>
      </FieldRow>;
    })}
    <span className="probe-announcement" role="status">{failure ? t(failure.key) : ''}</span>
  </>;
}
