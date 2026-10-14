// 设置页三段式（对照柚子社 config 结构）：
//   顶部 tab 条——独立全宽容器，页签均分铺满；
//   中部内容——行式设置项（左标签右控件，发丝线分隔）；
//   底部操作条——独立全宽容器，返回/保存聚拢右下角。
// 草稿模型：修改先存草稿，右下「保存」统一落盘（防抖 300ms 写
// .momo-state.json）；有未保存修改时点返回 → 居中弹窗
// （保存并离开/不保存离开/取消，主操作自动聚焦）。

import { useEffect, useRef, useState } from "react";
import {
  getPersona,
  getPins,
  getSettings,
  personaName,
  update,
} from "../lib/store";
import { getChatEngine } from "../chat/engine";
import type { PersonaCard, Settings as SettingsData } from "../lib/types";
import { fromRoute, navigate } from "../router";
import { useT, LANGS } from "../i18n";
import { probeAsr, probeLlm, probeTts } from "../services/probe";
import type { ProbeResult } from "../services/probe";
import Select from "../ui/Select";
import PersonaPanel, { cleanPersona } from "./Persona";
import MemoryPanel from "./Memory";
import AvatarPanel from "./Avatar";
import "../styles/settings.css";

type EndpointSection = "llm" | "asr" | "tts";
type Section = "general" | "models" | "persona" | "memory";

const TABS: Section[] = ["general", "models", "persona", "memory"];

interface Draft {
  settings: SettingsData;
  persona: PersonaCard;
  pins: string[];
}

function makeDraft(): Draft {
  return {
    settings: structuredClone(getSettings()),
    persona: structuredClone(getPersona()),
    pins: [...getPins()],
  };
}

function isDirty(d: Draft): boolean {
  return (
    JSON.stringify(d.settings) !== JSON.stringify(getSettings()) ||
    JSON.stringify(d.persona) !== JSON.stringify(getPersona()) ||
    JSON.stringify(d.pins) !== JSON.stringify(getPins())
  );
}

/** 行式设置项：左标签 + 右控件（柚子 config 式单行密度）。 */
function OptRow({
  label,
  extra,
  children,
}: {
  label: string;
  /** 标签右侧小字（如滑块当前值）。 */
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="opt-row">
      <span className="opt-label">
        {label}
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
  const [draft, setDraft] = useState<Draft>(makeDraft);
  const [tab, setTab] = useState<Section>("general");
  const [confirmLeave, setConfirmLeave] = useState(false);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const [showKey, setShowKey] = useState<Record<EndpointSection, boolean>>({
    llm: false,
    asr: false,
    tts: false,
  });
  const [probes, setProbes] = useState<
    Partial<Record<EndpointSection, ProbeResult | "running">>
  >({});
  // 语音输出开关：与 chat 工具条同一个开关（引擎运行时态，即时生效不入草稿）。
  const [voiceMuted, setVoiceMuted] = useState(getChatEngine().muted);
  const ttsConfigured = draft.settings.tts.url.trim() !== "";

  const toggleVoice = (on: boolean): void => {
    const eng = getChatEngine();
    eng.setMuted(!on);
    setVoiceMuted(eng.muted);
  };

  const PROBES: Record<
    EndpointSection,
    (s: SettingsData) => Promise<ProbeResult>
  > = {
    llm: (s) => probeLlm(s.llm),
    asr: (s) => probeAsr(s.asr),
    tts: (s) => probeTts(s.tts),
  };

  /** 探测的是草稿里的地址——改了没保存也能测当前填的值。 */
  const runProbe = (sec: EndpointSection): void => {
    if (probes[sec] === "running") return;
    setProbes((p) => ({ ...p, [sec]: "running" }));
    void PROBES[sec](draft.settings).then((r) =>
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
  ): React.ReactNode => (
    <OptRow label={sec === "llm" ? t("settings.apiUrl") : t("settings.svcUrl")}>
      <input
        value={draft.settings[sec].url}
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
      {probeText(sec)}
    </OptRow>
  );

  // 弹窗居中弹出，主操作聚焦（Enter 直接确认）。
  useEffect(() => {
    if (confirmLeave) primaryRef.current?.focus();
  }, [confirmLeave]);

  const dirty = isDirty(draft);
  // 返回目标与来源页一致：chat 进来回 chat，其余回 title。
  const backRoute = fromRoute() === "chat" ? ("chat" as const) : ("title" as const);
  const backLabel =
    backRoute === "chat" ? t("common.backChat") : t("common.backTitle");

  const patchEndpoint = (sec: EndpointSection, key: string, v: string): void => {
    setDraft((d) => ({
      ...d,
      settings: { ...d.settings, [sec]: { ...d.settings[sec], [key]: v } },
    }));
  };

  const patchGeneral = (p: Partial<SettingsData["general"]>): void => {
    setDraft((d) => ({
      ...d,
      settings: { ...d.settings, general: { ...d.settings.general, ...p } },
    }));
  };

  const patchPersona = (p: Partial<PersonaCard>): void => {
    setDraft((d) => ({ ...d, persona: { ...d.persona, ...p } }));
  };

  const save = (): void => {
    const persona = cleanPersona(draft.persona);
    const pins = draft.pins.map((s) => s.trim()).filter(Boolean);
    update({
      settings: structuredClone(draft.settings),
      persona,
      pins,
    });
    // 清洗后的字段回写草稿，保持 dirty 状态一致。
    setDraft((d) => ({
      ...d,
      persona: structuredClone(persona),
      pins,
    }));
  };

  const goBack = (): void => {
    if (dirty) {
      setConfirmLeave(true);
    } else {
      navigate(backRoute);
    }
  };

  const keyRow = (sec: EndpointSection) => (
    <OptRow label={t("settings.apiKey")}>
      <input
        type={showKey[sec] ? "text" : "password"}
        value={draft.settings[sec].key}
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
            <PersonaPanel value={draft.persona} onChange={patchPersona} />
          ) : tab === "memory" ? (
            <MemoryPanel
              pins={draft.pins}
              onPins={(pins) => setDraft((d) => ({ ...d, pins }))}
            />
          ) : (
            <div className="settings-body panel">
              {tab === "general" && (
                <div className="opt-list">
                  <OptRow label={t("settings.langLabel")}>
                    <Select
                      value={draft.settings.general.lang}
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
                  <OptRow
                    label={t("settings.dialogOpacity")}
                    extra={`${draft.settings.general.dialogOpacity}%`}
                  >
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      style={rangeFill(draft.settings.general.dialogOpacity)}
                      value={draft.settings.general.dialogOpacity}
                      onChange={(e) =>
                        patchGeneral({ dialogOpacity: Number(e.target.value) })
                      }
                    />
                  </OptRow>
                  {/* 对话框透明度实时预览（草稿值直接喂 CSS 变量） */}
                  <div
                    className="dialog-preview"
                    style={
                      {
                        "--dialog-alpha":
                          draft.settings.general.dialogOpacity / 100,
                      } as React.CSSProperties
                    }
                  >
                    <div className="dialog-box">
                      <div className="nameplate">
                        {draft.persona.name || personaName()}
                      </div>
                      <div className="subtitle">
                        {t("settings.previewSample")}
                      </div>
                    </div>
                  </div>
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
                    extra={`${draft.settings.general.voiceVolume}%`}
                  >
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      disabled={voiceMuted || !ttsConfigured}
                      style={rangeFill(draft.settings.general.voiceVolume)}
                      value={draft.settings.general.voiceVolume}
                      onChange={(e) =>
                        patchGeneral({ voiceVolume: Number(e.target.value) })
                      }
                    />
                  </OptRow>
                  <OptRow label={t("settings.showStatus")}>
                    <OptSwitch
                      on={draft.settings.general.showStatus}
                      onChange={(v) => patchGeneral({ showStatus: v })}
                    />
                  </OptRow>
                </div>
              )}

              {tab === "models" && (
                <div className="opt-list">
                  <h3 className="opt-group">{t("settings.groups.llm")}</h3>
                  {urlRow("llm", "settings.llmUrlPh")}
                  {keyRow("llm")}
                  <OptRow label={t("settings.model")}>
                    <input
                      value={draft.settings.llm.model}
                      placeholder={t("settings.llmModelPh")}
                      onChange={(e) => patchEndpoint("llm", "model", e.target.value)}
                    />
                  </OptRow>

                  <h3 className="opt-group">{t("settings.groups.asr")}</h3>
                  {urlRow("asr", "settings.asrUrlPh")}
                  {keyRow("asr")}

                  <h3 className="opt-group">{t("settings.groups.tts")}</h3>
                  {urlRow("tts", "settings.ttsUrlPh")}
                  {keyRow("tts")}
                  <OptRow label={t("settings.voice")}>
                    <input
                      value={draft.settings.tts.voice}
                      placeholder={t("settings.voicePh")}
                      onChange={(e) => patchEndpoint("tts", "voice", e.target.value)}
                    />
                  </OptRow>
                  <OptRow label={t("settings.speechLang")}>
                    <Select
                      value={draft.settings.tts.lang}
                      options={[
                        { value: "zh", label: "中文" },
                        { value: "en", label: "English" },
                        { value: "ja", label: "日本語" },
                        { value: "auto", label: "auto" },
                      ]}
                      onChange={(v) => patchEndpoint("tts", "lang", v)}
                    />
                  </OptRow>

                  <h3 className="opt-group">{t("settings.groups.avatar")}</h3>
                  <AvatarPanel />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 底部操作条：独立全宽容器，返回/保存聚拢右下 */}
      <footer className="footbar">
        <div className="footbar-inner">
          <div className="foot-right">
            <button className="ghost" onClick={goBack}>
              {backLabel}
            </button>
            <button onClick={save} disabled={!dirty}>
              {t("settings.saveBtn")}
            </button>
          </div>
        </div>
      </footer>

      {confirmLeave && (
        <div className="modal-backdrop">
          <div className="modal panel">
            <h2>{t("settings.unsavedTitle")}</h2>
            <p className="muted">{t("settings.unsavedBody")}</p>
            <div className="modal-ops">
              <button className="ghost" onClick={() => setConfirmLeave(false)}>
                {t("common.cancel")}
              </button>
              <button
                className="ghost"
                onClick={() => navigate(backRoute)}
              >
                {t("settings.discardLeave")}
              </button>
              <button
                ref={primaryRef}
                onClick={() => {
                  save();
                  navigate(backRoute);
                }}
              >
                {t("settings.saveLeave")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
