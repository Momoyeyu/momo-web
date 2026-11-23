import {useEffect, useMemo, useState, useSyncExternalStore} from 'react';
import {getSettings, subscribe} from '../lib/store';

const selectedZone = () => getSettings().general.phoneTimeZone || '';

export function usePhoneTimeZone() {
  const selected = useSyncExternalStore(subscribe, selectedZone);
  return useMemo(() => {
    if (!selected) return '';
    try {
      new Intl.DateTimeFormat(undefined, {timeZone:selected});
      return selected;
    } catch {
      return '';
    }
  }, [selected]);
}

export function usePhoneNow(running: boolean) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!running) return;
    const tick = () => setNow(new Date());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

export function formatPhoneTime(now: Date, lang: string, timeZone: string) {
  return new Intl.DateTimeFormat(lang, {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: timeZone || undefined,
  }).format(now);
}
