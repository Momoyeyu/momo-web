import {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {useT} from '../../i18n';
import {getState, subscribe, update} from '../../lib/store';
import type {LlmConfig} from '../../lib/types';
import {probeVision, visionStatus} from '../../services/visionClient';
import ProbeButton from './ProbeButton';
import FieldRow from '../../ui/FieldRow';
import Switch from '../../ui/Switch';

const resultKeys: Record<string, string> = {
  verified: 'vision.verified', 'not verified': 'vision.notVerified', unconfigured: 'settings.testNeedUrl',
  timeout: 'config.timeout', unreachable: 'config.unreachable', 'invalid response': 'config.invalidResponse',
};
const fingerprint = ({url, key, model}: LlmConfig) => JSON.stringify([url, key, model]);
const unchecked = {signature: '', verified: false, running: false, detail: '', attempted: null as boolean | null};

export default function VisionSettings() {
  const t = useT();
  const {llm} = useSyncExternalStore(subscribe, getState).settings;
  const signature = fingerprint(llm);
  const configured = !!(llm.url.trim() && llm.model.trim());
  const [result, setResult] = useState(unchecked);
  const verification = useRef<AbortController | null>(null);
  const current = result.signature === signature ? result : unchecked;
  useEffect(() => {
    if (!configured) return;
    const controller = new AbortController();
    setResult({...unchecked, signature});
    void visionStatus(getState().settings.llm, controller.signal).then(({verified}) => {
      if (controller.signal.aborted) return;
      setResult(value => !value.running && !value.detail ? {...value, verified} : value);
    }).catch(() => {});
    return () => {
      controller.abort();
      verification.current?.abort();
      verification.current = null;
    };
  }, [signature, configured]);

  async function verify() {
    if (!configured || verification.current) return;
    const controller = new AbortController();
    verification.current = controller;
    setResult({...current, signature, running: true, detail: '', attempted: null});
    try {
      const {ok, detail} = await probeVision(llm, controller.signal);
      if (!controller.signal.aborted) setResult({signature, verified: ok, running: false, detail, attempted: ok});
    } catch (error) {
      if (!controller.signal.aborted) {
        const detail = error instanceof Error && /^HTTP \d{3}$/.test(error.message) ? error.message : 'unreachable';
        setResult(value => ({...value, running: false, detail, attempted: false}));
      }
    } finally {
      if (verification.current === controller) verification.current = null;
    }
  }

  const verifyLabel = t('vision.verify');
  const status = !configured ? t('settings.probe.unavailable') : current.running ? t('vision.loading')
    : current.attempted === true ? t('vision.verified') : current.detail
    ? /^HTTP \d{3}$/.test(current.detail)
      ? current.detail + ' · ' + t('vision.checkFailed')
      : t(resultKeys[current.detail] ?? 'vision.checkFailed')
    : t(current.verified ? 'vision.verified' : 'config.pending');

  return <div className="vision-settings">
    <FieldRow label={t('config.vision')} hint={t('vision.hint')}>
      <Switch title={t('vision.label')} on={!!llm.vision} disabled={!llm.vision && (!current.verified || current.running)} onChange={vision => {
        const settings = getState().settings;
        if (fingerprint(settings.llm) === signature) update({settings: {...settings, llm: {...settings.llm, vision}}});
      }}/>
      <ProbeButton idleIcon="focus" label={verifyLabel}
        state={!configured ? 'unavailable' : current.running ? 'running'
          : (current.attempted ?? current.verified) ? 'passed' : current.attempted === false ? 'failed' : 'idle'}
        detail={status} onClick={() => void verify()}/>
    </FieldRow>
  </div>;
}
