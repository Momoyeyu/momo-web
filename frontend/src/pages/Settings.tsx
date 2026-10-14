// 设置页三段式（对照柚子社 config 结构）：
//   顶部 tab 条——独立全宽容器，页签均分铺满；
//   中部内容——行式设置项（左标签右控件，发丝线分隔）；
//   底部操作条——返回按钮聚拢右下。
// 即改即生效：每次修改直接 update() 落盘（localStorage + 防抖 PUT
// /api/state），无草稿/保存概念——语言切换等立即生效。

import { useState, useSyncExternalStore } from "react";
import {
  getState,
  personaName,
  subscribe,
  update,
} from "../lib/store";
import { getChatEngine } from "../chat/engine";
import type { Settings as SettingsData } from "../lib/types";
import { fromRoute, navigate } from "../router";
import { useT, LANGS } from "../i18n";
import {
  probeAsr,
  probeEmbedding,
  probeLlm,
  probeTts,
} from "../services/probe";
import type { ProbeResult } from "../services/probe";
import Select from "../ui/Select";
import PersonaPanel from "./Persona";
import MemoryPanel from "./Memory";
import AvatarPanel from "./Avatar";
import "../styles/settings.css";

type EndpointSection = "llm" | "asr" | "tts" | "embedding";
type Section = "general" | "models" | "persona" | "memory";

const TABS: Section[] = ["general", "models", "persona", "memory"];

const URL_SCHEMES: Record<EndpointSection, string[]> = {
  llm: ["http:", "https:"],
  tts: ["http:", "https:"],
  asr: ["ws:", "wss:"],
  embedding: ["http:", "https:"],
};

/** URL 合法性：空为未配置（不算错），非空必须能解析且协议匹配。 */
function urlError(sec: EndpointSection, url: string): boolean {
  const v = url.trim();
  if (!v) return false;
  try {
    return !URL_SCHEMES[sec].includes(new URL(v).protocol);
  } catch {
    return true;
  }
}

/** 行式设置项：左标签 + 右控件（柚子 config 式单行密度）。 */
function OptRow({
  label,
  extra,
  required,
  children,
}: {
  label: string;
  /** 标签右侧小字（如滑块当前值）。 */
  extra?: React.ReactNode;
  /** 必填项：标签后加 * 标记。 */
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="opt-row">
      <span className="opt-label">
        {label}
        {required && <span className="req">*</span>}
        {extra && <span className="opt-extra">{extra}</span>}
      </span>
      <div className="opt-ctl">{children}</div>
    </div>
  );
}

/** 滑块已填充段着色：0–100 → 左金右灰的轨道渐变。 */
function rangeFill(pct: number): React.CSSProperties {
  return {
    background: `linear-gradient(90deg, var(--accent) 0%, var(--accent) ${pct}%, var(--line) ${pct}%, var(--line) 100%)`,
  };
}

/** 开关行控件：pill switch。 */
function OptSwitch({
  on,
  onChange,
  disabled,
  title,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`opt-switch${on ? " on" : ""}`}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!on)}
    >
      <span className="knob" />
    </button>
  );
}

export default function Settings() {
  const t = useT();
  // 订阅 store：外部（如启动同步）改动也能刷新本页。
  const state = useSyncExternalStore(subscribe, getState);
  const settings = state.settings;
  const [tab, setTab] = useState<Section>("general");
  const [showKey, setShowKey] = useState<Record<EndpointSection, boolean>>({
    llm: false,
    asr: false,
    tts: false,
    embedding: false,
  });
  const [probes, setProbes] = useState<
    Partial<Record<EndpointSection, ProbeResult | "running">>
  >({});
  // 语音输出开关：与 chat 工具条同一个开关（引擎运行时态）。
  const [voiceMuted, setVoiceMuted] = useState(getChatEngine().muted);
  const ttsConfigured = settings.tts.url.trim() !== "";
  const asrConfigured = settings.asr.url.trim() !== "";
  const embConfigured = settings.embedding.url.trim() !== "";

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

  const PROBES: Record<
    EndpointSection,
    (s: SettingsData) => Promise<ProbeResult>
  > = {
    llm: (s) => probeLlm(s.llm),
    asr: (s) => probeAsr(s.asr),
    tts: (s) => probeTts(s.tts),
    embedding: (s) => probeEmbedding(s.embedding),
  };

  const runProbe = (sec: EndpointSection): void => {
    if (probes[sec] === "running") return;
    setProbes((p) => ({ ...p, [sec]: "running" }));
    void PROBES[sec](settings).then((r) =>
      setProbes((p) => ({ ...p, [sec]: r })),
    );
  };

  const probeText = (sec: EndpointSection): React.ReactNode => {
    const r = probes[sec];
    if (!r) return null;
    if (r === "running") return <span className="probe-info">…</span>;
    const detail =
      r.detail === "unconfigured"
        ? t("settings.testNeedUrl")
        : /^(unreachable|timeout|connect failed|bad url|closed)/.test(r.detail)
          ? t("chat.errConn")
          : r.detail;
    return (
      <span className={r.ok ? "probe-ok" : "probe-err"}>
        {r.ok ? "✓" : "✗"} {detail}
      </span>
    );
  };

  const urlRow = (
    sec: EndpointSection,
    phKey: string,
    required = false,
  ): React.ReactNode => (
    <OptRow
      label={sec === "llm" ? t("settings.apiUrl") : t("settings.svcUrl")}
      required={required}
    >
      <input
        className={urlError(sec, settings[sec].url) ? "invalid" : undefined}
        value={settings[sec].url}
        placeholder={t(phKey)}
        onChange={(e) => patchEndpoint(sec, "url", e.target.value)}
      />
      <button
        type="button"
        className="ghost key-toggle"
        onClick={() => runProbe(sec)}
        disabled={probes[sec] === "running"}
      >
        {t("settings.test")}
      </button>
      {urlError(sec, settings[sec].url) ? (
        <span className="probe-err">{t("settings.invalidUrl")}</span>
      ) : (
        required &&
        !settings[sec].url.trim() && (
          <span className="probe-err">{t("settings.required")}</span>
        )
      )}
      {probeText(sec)}
    </OptRow>
  );

  // 返回目标与来源页一致：chat 进来回 chat，其余回 title。
  const backRoute = fromRoute() === "chat" ? ("chat" as const) : ("title" as const);
  const backLabel =
    backRoute === "chat" ? t("common.backChat") : t("common.backTitle");

  const patchEndpoint = (sec: EndpointSection, key: string, v: string): void => {
    update({
      settings: { ...settings, [sec]: { ...settings[sec], [key]: v } },
    });
  };

  const patchGeneral = (p: Partial<SettingsData["general"]>): void => {
    update({
      settings: { ...settings, general: { ...settings.general, ...p } },
    });
  };

  const keyRow = (sec: "llm" | "asr" | "tts") => (
    <OptRow label={t("settings.apiKey")}>
      <input
        type={showKey[sec] ? "text" : "password"}
        value={settings[sec].key}
        placeholder={t("settings.keyPh")}
        onChange={(e) => patchEndpoint(sec, "key", e.target.value)}
      />
      <button
        type="button"
        className="ghost key-toggle"
        onClick={() => setShowKey((s) => ({ ...s, [sec]: !s[sec] }))}
      >
        {showKey[sec] ? t("settings.hideKey") : t("settings.showKey")}
      </button>
    </OptRow>
  );

  return (
    <div className="settings-page">
      {/* 顶部 tab 条：独立全宽容器，页签均分铺满 */}
      <nav className="tabstrip">
        <div className="tabstrip-inner">
          {TABS.map((id) => (
            <button
              key={id}
              className={`stab${tab === id ? " active" : ""}`}
              onClick={() => setTab(id)}
            >
              <span className="stab-label">{t(`settings.tabs.${id}`)}</span>
            </button>
          ))}
        </div>
      </nav>

      {/* 中部内容区 */}
      <div className="settings-scroll">
        <div className="settings-content">
          {tab === "persona" ? (
            <PersonaPanel
              value={state.persona}
              onChange={(p) =>
                update({ persona: { ...state.persona, ...p } })
              }
            />
          ) : tab === "memory" ? (
            <MemoryPanel
              pins={state.pins}
              onPins={(pins) => update({ pins })}
            />
          ) : (
            <div className="settings-body panel">
              {tab === "general" && (
                <div className="opt-list">
                  <OptRow label={t("settings.langLabel")}>
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
                  </OptRow>
                  <OptRow label={t("settings.chatLang")}>
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
                  </OptRow>
                  <OptRow
                    label={t("settings.dialogOpacity")}
                    extra={`${settings.general.dialogOpacity}%`}
                  >
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      style={rangeFill(settings.general.dialogOpacity)}
                      value={settings.general.dialogOpacity}
                      onChange={(e) =>
                        patchGeneral({ dialogOpacity: Number(e.target.value) })
                      }
                    />
                  </OptRow>
                  {/* 对话框透明度实时预览 */}
                  <div
                    className="dialog-preview"
                    style={
                      {
                        "--dialog-alpha":
                          settings.general.dialogOpacity / 100,
                      } as React.CSSProperties
                    }
                  >
                    <div className="dialog-box">
                      <div className="nameplate">
                        {state.persona.name || personaName()}
                      </div>
                      <div className="subtitle">
                        {t("settings.previewSample")}
                      </div>
                    </div>
                  </div>
                  <OptRow
                    label={t("settings.voiceInput")}
                    extra={!asrConfigured ? t("settings.voiceNeedAsr") : undefined}
                  >
                    <OptSwitch
                      on={asrConfigured && settings.general.voiceInput}
                      disabled={!asrConfigured}
                      title={
                        !asrConfigured ? t("settings.voiceNeedAsr") : undefined
                      }
                      onChange={toggleVoiceInput}
                    />
                  </OptRow>
                  <OptRow
                    label={t("settings.voiceOut")}
                    extra={!ttsConfigured ? t("settings.voiceNeedTts") : undefined}
                  >
                    <OptSwitch
                      on={ttsConfigured && !voiceMuted}
                      disabled={!ttsConfigured}
                      title={
                        !ttsConfigured ? t("settings.voiceNeedTts") : undefined
                      }
                      onChange={toggleVoice}
                    />
                  </OptRow>
                  <OptRow
                    label={t("settings.voiceVolume")}
                    extra={`${settings.general.voiceVolume}%`}
                  >
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      disabled={voiceMuted || !ttsConfigured}
                      style={rangeFill(settings.general.voiceVolume)}
                      value={settings.general.voiceVolume}
                      onChange={(e) =>
                        patchGeneral({ voiceVolume: Number(e.target.value) })
                      }
                    />
                  </OptRow>
                  <OptRow
                    label={t("settings.semanticSearch")}
                    extra={!embConfigured ? t("settings.embNeedCfg") : undefined}
                  >
                    <OptSwitch
                      on={embConfigured && settings.general.semanticSearch}
                      disabled={!embConfigured}
                      title={
                        !embConfigured ? t("settings.embNeedCfg") : undefined
                      }
                      onChange={(v) => patchGeneral({ semanticSearch: v })}
                    />
                  </OptRow>
                  <OptRow label={t("settings.showStatus")}>
                    <OptSwitch
                      on={settings.general.showStatus}
                      onChange={(v) => patchGeneral({ showStatus: v })}
                    />
                  </OptRow>
                </div>
              )}

              {tab === "models" && (
                <div className="opt-list">
                  <h3 className="opt-group">{t("settings.groups.llm")}</h3>
                  {urlRow("llm", "settings.llmUrlPh", true)}
                  {keyRow("llm")}
                  <OptRow label={t("settings.model")} required>
                    <input
                      className={
                        settings.llm.model.trim() ? undefined : "invalid"
                      }
                      value={settings.llm.model}
                      placeholder={t("settings.llmModelPh")}
                      onChange={(e) => patchEndpoint("llm", "model", e.target.value)}
                    />
                    {!settings.llm.model.trim() && (
                      <span className="probe-err">{t("settings.required")}</span>
                    )}
                  </OptRow>

                  <h3 className="opt-group">{t("settings.groups.asr")}</h3>
                  {urlRow("asr", "settings.asrUrlPh")}
                  {keyRow("asr")}

                  <h3 className="opt-group">{t("settings.groups.tts")}</h3>
                  {urlRow("tts", "settings.ttsUrlPh")}
                  {keyRow("tts")}
                  <OptRow label={t("settings.voice")}>
                    <input
                      value={settings.tts.voice}
                      placeholder={t("settings.voicePh")}
                      onChange={(e) => patchEndpoint("tts", "voice", e.target.value)}
                    />
                  </OptRow>
                  <OptRow label={t("settings.speechLang")}>
                    <Select
                      value={settings.tts.lang}
                      options={[
                        { value: "zh", label: "中文" },
                        { value: "en", label: "English" },
                        { value: "ja", label: "日本語" },
                        { value: "auto", label: "auto" },
                      ]}
                      onChange={(v) => patchEndpoint("tts", "lang", v)}
                    />
                  </OptRow>

                  <h3 className="opt-group">
                    {t("settings.groups.embedding")}
                  </h3>
                  {urlRow("embedding", "settings.embUrlPh")}
                  <OptRow label={t("settings.model")}>
                    <input
                      value={settings.embedding.model}
                      placeholder={t("settings.embModelPh")}
                      onChange={(e) =>
                        patchEndpoint("embedding", "model", e.target.value)
                      }
                    />
                  </OptRow>

                  <h3 className="opt-group">
                    {t("settings.groups.avatar")}
                    <span className="req">*</span>
                  </h3>
                  <AvatarPanel />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 底部操作条：返回按钮聚拢右下 */}
      <footer className="footbar">
        <div className="footbar-inner">
          <div className="foot-right">
            <button className="ghost" onClick={() => navigate(backRoute)}>
              {backLabel}
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
