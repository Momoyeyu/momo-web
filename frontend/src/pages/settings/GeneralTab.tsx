import Button from '../../ui/Button';
import {ambient} from '../../audio/ambient';
import {useIntro} from "../../services/introClient";
import DataTransfer from "./DataTransfer";
// 「通用」tab：界面语言与对话语言、语音输入/输出、对话框透明度与速度、对话框预览。
// 原先这些都挤在 Settings.tsx 里，状态与补丁函数一并搬过来。
import { useState, useSyncExternalStore } from "react";

import { getChatEngine } from "../../chat/engineInstance";
import { useT, tFor, LANGS } from "../../i18n";
import { ttsConfigured as ttsReadyOf } from "../../lib/asr";
import { getState, speakerName, subscribe, update } from "../../lib/store";
import type { Settings as SettingsData } from "../../lib/types";
import FieldRow from "../../ui/FieldRow";
import Select from "../../ui/Select";
import Slider from "../../ui/Slider";
import Switch from "../../ui/Switch";
import DialogPreview from "./DialogPreview";

export default function GeneralTab() {
  const t = useT();
  const intro=useIntro();
  const guided=!!intro.data && intro.data.phase!=="completed";
  const settings = useSyncExternalStore(subscribe, getState).settings;

  const [voiceMuted, setVoiceMuted] = useState(getChatEngine().muted);
  const ttsReady = ttsReadyOf(settings.tts);

  const toggleVoice = (on: boolean): void => {
    const eng = getChatEngine();
    eng.setMuted(!on);
    setVoiceMuted(eng.muted);
  };

  const toggleVoiceInput = (on: boolean): void => {
    patchGeneral({ voiceInput: on });
    // 关掉时若正在聆听，同时收掉麦克风。
    if (!on) getChatEngine().stopListening();
  };

  const patchGeneral = (p: Partial<SettingsData["general"]>): void => {
    update({
      settings: { ...settings, general: { ...settings.general, ...p } },
    });
  };


  return (
<div className="general-settings">
<section className="panel settings-col panel-raised general-language">
  <h3 className="opt-group">{t("settings.groups.lang")}</h3>
  <div className="opt-list">
  <div data-intro="language"><FieldRow label={t("settings.langLabel")}>
    <Select
      value={settings.general.lang}
      options={LANGS.map((l) => ({
        value: l,
        label: t(`settings.langs.${l}`),
      }))}
      onChange={(v) =>
        patchGeneral({
          lang: v as SettingsData["general"]["lang"],
        })
      }
    />
  </FieldRow>
  </div><div inert={guided} aria-disabled={guided}><FieldRow label={t("settings.chatLang")}>
    <Select
      value={guided ? "auto" : settings.general.chatLang}
      options={[
        { value: "auto", label: t("settings.langAuto") },
        ...LANGS.map((l) => ({
          value: l,
          label: t(`settings.langs.${l}`),
        })),
      ]}
      onChange={(v) =>
        patchGeneral({
          chatLang: v as SettingsData["general"]["chatLang"],
        })
      }
    />
  </FieldRow></div>
  </div>
</section>
<div className="settings-cols general-columns">

<section className="panel settings-col">
  <h3 className="opt-group">{t("settings.groups.voice")}</h3>
  <div className="opt-list">
  <FieldRow
    label={t("settings.voiceInput")}
  >
    <Switch
      on={settings.general.voiceInput}
      onChange={toggleVoiceInput}
    />
  </FieldRow>
  <FieldRow
    label={t("settings.voiceOut")}
    hint={!ttsReady ? t("settings.voiceNeedTts") : undefined}
  >
    <Switch
      on={ttsReady && !voiceMuted}
      disabled={!ttsReady}
      title={
        !ttsReady ? t("settings.voiceNeedTts") : undefined
      }
      onChange={toggleVoice}
    />
  </FieldRow>
  <FieldRow label={t("settings.voiceVolume")}>
    <Slider
      disabled={voiceMuted || !ttsReady}
      value={settings.general.voiceVolume}
      onChange={(v) => patchGeneral({ voiceVolume: v })}
    />
  </FieldRow>
  <FieldRow label={t("settings.sfxVolume")}><Slider value={settings.general.sfxVolume??35} onChange={v=>patchGeneral({sfxVolume:v})}/></FieldRow>
  <FieldRow label={t("settings.musicVolume")}><Slider value={settings.general.musicVolume??22} onChange={v=>patchGeneral({musicVolume:v})}/></FieldRow>
  <FieldRow label={t("settings.soundPalette")}><Select value={settings.general.soundPalette??'warm'} options={[{value:'warm',label:t('settings.soundWarm')},{value:'glass',label:t('settings.soundGlass')}]} onChange={v=>patchGeneral({soundPalette:v as 'warm'|'glass'})}/><Button variant="ghost" size="sm" onClick={()=>ambient.sound('complete')}>{t('settings.soundPreview')}</Button></FieldRow>
  </div>
</section>


{/* 对话框预览紧跟控制项，与声音面板并列。 */}
<section className="panel settings-col">
  <h3 className="opt-group">
    {t("settings.groups.dialog")}
  </h3>
  <div className="opt-list">
  <FieldRow label={t("settings.dialogOpacity")}>
    <Slider
      value={settings.general.dialogOpacity}
      onChange={(v) => patchGeneral({ dialogOpacity: v })}
    />
  </FieldRow>
  <FieldRow label={t("settings.textSpeed")}>
    <Slider
      value={settings.general.textSpeed}
      onChange={(v) => patchGeneral({ textSpeed: v })}
    />
  </FieldRow>
  <FieldRow label={t("settings.sentenceSpeed")}>
    <Slider
      value={settings.general.sentenceSpeed}
      onChange={(v) => patchGeneral({ sentenceSpeed: v })}
    />
  </FieldRow>
  <FieldRow label={t("settings.showStatus")}>
    <Switch
      on={settings.general.showStatus}
      onChange={(v) => patchGeneral({ showStatus: v })}
    />
  </FieldRow>
  </div>
  {/* 对话框实时预览：多句循环，逐字上屏 + 按切句速度换句 */}
  <div className="col-foot">
    <DialogPreview
      lang={settings.general.chatLang === "auto" ? settings.general.lang : settings.general.chatLang}
      name={speakerName()}
      // 预览语言跟随「对话语言」：auto 回落到界面语言
      sample={tFor(
        settings.general.chatLang === "auto"
          ? settings.general.lang
          : settings.general.chatLang,
        "settings.previewSample",
      )}
      opacity={settings.general.dialogOpacity}
      textSpeed={settings.general.textSpeed}
      sentenceSpeed={settings.general.sentenceSpeed}
      showStatus={settings.general.showStatus}
    />
  </div>
</section>
</div>
<DataTransfer />
</div>
  );
}
