// 设置页三段式（对照柚子社 config 结构）：
//   顶部 tab 条——独立全宽容器，页签均分铺满；
//   中部内容——双栏面板（底边对齐：底部行为钉底、中段留白为弹性区）；
//   底部操作条——返回按钮聚拢右下。
// 即改即生效：每次修改直接 update() 落盘（localStorage + 防抖 PUT
// /api/state），无草稿/保存概念——语言切换等立即生效。

import { useState, useSyncExternalStore } from "react";
import {
  getState,
  speakerName,
  subscribe,
  update,
} from "../lib/store";
import { getChatEngine } from "../chat/engineInstance";
import type {
  
  Settings as SettingsData,
} from "../lib/types";
import { fromRoute, navigate } from "../router";
import { useT, tFor, LANGS } from "../i18n";
import FieldRow from "../ui/FieldRow";
import Slider from "../ui/Slider";
import Switch from "../ui/Switch";
import Button from "../ui/Button";
import Select from "../ui/Select";
import MemoryPanel from "./panels/Memory";
import "../styles/settings.css";

type Section = "general" | "models" | "memory" | "extend";

const TABS: Section[] = [
  "general",
  "models",
  "memory",
  "extend",
];

import DialogPreview from "./settings/DialogPreview";
import ExtensionsTab from "./settings/ExtensionsTab";
import ModelsTab from "./settings/ModelsTab";
export default function Settings() {
  const t = useT();
  // 订阅 store：外部（如启动同步）改动也能刷新本页。
  const state = useSyncExternalStore(subscribe, getState);
  const settings = state.settings;
  const [tab, setTab] = useState<Section>("general");
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

  const backRoute = fromRoute() === "chat" ? ("chat" as const) : ("title" as const);
  const backLabel =
    backRoute === "chat" ? t("common.backChat") : t("common.backTitle");

  const patchGeneral = (p: Partial<SettingsData["general"]>): void => {
    update({
      settings: { ...settings, general: { ...settings.general, ...p } },
    });
  };

  // ---- 拓展 · MCP ----


  return (
    <div className="settings-page">
      <nav className="tabstrip">
        <div className="tabstrip-inner">
          {TABS.map((id) => (
            <Button
              key={id}
              className={`stab${tab === id ? " active" : ""}`}
              onClick={() => setTab(id)}
            >
              <span className="stab-label">{t(`settings.tabs.${id}`)}</span>
            </Button>
          ))}
        </div>
      </nav>
      <div className="settings-scroll">
        <div className="settings-content">
          {tab === "memory" ? (
            <MemoryPanel />
          ) : (
            <div className="settings-body">
              {tab === "general" && (
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
              )}

              {tab === "models" && <ModelsTab />}
              {tab === "extend" && <ExtensionsTab />}
                </div>
          )}
        </div>
      </div>

      {/* 底部操作条：返回按钮聚拢右下 */}
      <footer className="footbar">
        <div className="footbar-inner">
          <div className="foot-right">
            <Button variant="ghost" onClick={() => navigate(backRoute)}>
              {backLabel}
            </Button>
          </div>
        </div>
      </footer>

    </div>
  );
}
