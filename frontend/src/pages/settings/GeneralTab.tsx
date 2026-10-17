// 「通用」tab：界面语言与对话语言、语音输入/输出、对话框透明度与速度、对话框预览。
// 原先这些都挤在 Settings.tsx 里，状态与补丁函数一并搬过来。
import { useState, useSyncExternalStore } from "react";

import { getChatEngine } from "../../chat/engineInstance";
import { useT, tFor, LANGS } from "../../i18n";
import { getState, speakerName, subscribe, update } from "../../lib/store";
import type { Settings as SettingsData } from "../../lib/types";
import FieldRow from "../../ui/FieldRow";
import Select from "../../ui/Select";
import Slider from "../../ui/Slider";
import Switch from "../../ui/Switch";
import DialogPreview from "./DialogPreview";

export default function GeneralTab() {
  const t = useT();
  const settings = useSyncExternalStore(subscribe, getState).settings;

  const [voiceMuted, setVoiceMuted] = useState(getChatEngine().muted);
  const ttsConfigured = settings.tts.url.trim() !== "";
  const asrConfigured = settings.asr.url.trim() !== "";

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

  // ---- 拓展 · MCP ----


  return (
<div className="settings-cols">
{/* 左栏：语言 / 语音两个独立面板，与右栏「对话框设置」同级；
    末块吃掉剩余高度，两栏总高因此对齐 */}
<div className="settings-stack">
{/* panel-raised：面板里的下拉展开时要盖住下面的「语音设置」 */}
<section className="panel settings-col panel-raised">
  <h3 className="opt-group">{t("settings.groups.lang")}</h3>
  <div className="opt-list">
  <FieldRow label={t("settings.langLabel")}>
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
  <FieldRow label={t("settings.chatLang")}>
    <Select
      value={settings.general.chatLang}
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
  </FieldRow>
  </div>
</section>

<section className="panel settings-col">
  <h3 className="opt-group">{t("settings.groups.voice")}</h3>
  <div className="opt-list">
  <FieldRow
    label={t("settings.voiceInput")}
    extra={!asrConfigured ? t("settings.voiceNeedAsr") : undefined}
  >
    <Switch
      on={asrConfigured && settings.general.voiceInput}
      disabled={!asrConfigured}
      title={
        !asrConfigured ? t("settings.voiceNeedAsr") : undefined
      }
      onChange={toggleVoiceInput}
    />
  </FieldRow>
  <FieldRow
    label={t("settings.voiceOut")}
    extra={!ttsConfigured ? t("settings.voiceNeedTts") : undefined}
  >
    <Switch
      on={ttsConfigured && !voiceMuted}
      disabled={!ttsConfigured}
      title={
        !ttsConfigured ? t("settings.voiceNeedTts") : undefined
      }
      onChange={toggleVoice}
    />
  </FieldRow>
  <FieldRow label={t("settings.voiceVolume")}>
    <Slider
      disabled={voiceMuted || !ttsConfigured}
      value={settings.general.voiceVolume}
      onChange={(v) => patchGeneral({ voiceVolume: v })}
    />
  </FieldRow>
  </div>
</section>
</div>
{/* 对话框设置子组：三滑块 + 预览同组联动，预览钉在面板底缘。 */}
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
  {/* 原在左栏；归到对话框设置后两栏高度也更均衡 */}
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
  );
}
