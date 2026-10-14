// 设置页三段式（对照柚子社 config 结构）：
//   顶部 tab 条——独立全宽容器，页签均分铺满；
//   中部内容——行式设置项（左标签右控件，发丝线分隔）；
//   底部操作条——独立全宽容器，左返回、右保存。
// 统一草稿模型：所有修改先存草稿（不即时写库）；
// 返回时若有未保存修改，弹窗询问（保存并离开/不保存离开/取消）。

import { useEffect, useRef, useState } from "react";
import {
  getHumanBlock,
  getPersona,
  getSettings,
  update,
} from "../lib/store";
import type { PersonaCard, Settings as SettingsData } from "../lib/types";
import { navigate } from "../router";
import { useT, LANGS } from "../i18n";
import Select from "../ui/Select";
import PersonaPanel, { cleanPersona } from "./Persona";
import MemoryPanel from "./Memory";
import "../styles/settings.css";

type EndpointSection = "llm" | "asr" | "tts";
type Section = "general" | EndpointSection | "persona" | "memory";

const TABS: Section[] = ["general", "llm", "asr", "tts", "persona", "memory"];

interface Draft {
  settings: SettingsData;
  persona: PersonaCard;
  humanBlock: string;
}

function makeDraft(): Draft {
  return {
    settings: structuredClone(getSettings()),
    persona: structuredClone(getPersona()),
    humanBlock: getHumanBlock(),
  };
}

function isDirty(d: Draft): boolean {
  return (
    JSON.stringify(d.settings) !== JSON.stringify(getSettings()) ||
    JSON.stringify(d.persona) !== JSON.stringify(getPersona()) ||
    d.humanBlock !== getHumanBlock()
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
    background: `linear-gradient(90deg, var(--accent) 0%, var(--accent) ${pct}%, rgba(226,197,152,0.16) ${pct}%, rgba(226,197,152,0.16) 100%)`,
  };
}

/** 开关行控件：pill switch。 */
function OptSwitch({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`opt-switch${on ? " on" : ""}`}
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
  const [saved, setSaved] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [showKey, setShowKey] = useState<Record<EndpointSection, boolean>>({
    llm: false,
    asr: false,
    tts: false,
  });
  const savedTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    },
    [],
  );

  const dirty = isDirty(draft);

  const patch = (sec: EndpointSection, key: string, v: string): void => {
    setDraft((d) => ({
      ...d,
      settings: { ...d.settings, [sec]: { ...d.settings[sec], [key]: v } },
    }));
    setSaved(false);
  };

  const patchGeneral = (p: Partial<SettingsData["general"]>): void => {
    setDraft((d) => ({
      ...d,
      settings: { ...d.settings, general: { ...d.settings.general, ...p } },
    }));
    setSaved(false);
  };

  const patchPersona = (p: Partial<PersonaCard>): void => {
    setDraft((d) => ({ ...d, persona: { ...d.persona, ...p } }));
    setSaved(false);
  };

  const save = (): void => {
    const persona = cleanPersona(draft.persona);
    update({
      settings: structuredClone(draft.settings),
      persona,
      humanBlock: draft.humanBlock.trim(),
    });
    // 清洗后的 persona 回写草稿，保持 dirty 状态一致。
    setDraft((d) => ({
      ...d,
      persona: structuredClone(persona),
      humanBlock: d.humanBlock.trim(),
    }));
    setSaved(true);
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSaved(false), 2000);
  };

  const goBack = (): void => {
    if (dirty) {
      setConfirmLeave(true);
    } else {
      navigate("title");
    }
  };

  const keyRow = (sec: EndpointSection) => (
    <OptRow label={t("settings.apiKey")}>
      <input
        type={showKey[sec] ? "text" : "password"}
        value={draft.settings[sec].key}
        placeholder={t("settings.keyPh")}
        onChange={(e) => patch(sec, "key", e.target.value)}
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
              <span className="stab-sub">{t(`settings.subs.${id}`)}</span>
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
              humanBlock={draft.humanBlock}
              onHumanBlock={(v) => {
                setDraft((d) => ({ ...d, humanBlock: v }));
                setSaved(false);
              }}
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
                  <OptRow
                    label={t("settings.voiceVolume")}
                    extra={`${draft.settings.general.voiceVolume}%`}
                  >
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
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

              {tab === "llm" && (
                <div className="opt-list">
                  <OptRow label={t("settings.apiUrl")}>
                    <input
                      value={draft.settings.llm.url}
                      placeholder={t("settings.llmUrlPh")}
                      onChange={(e) => patch("llm", "url", e.target.value)}
                    />
                  </OptRow>
                  {keyRow("llm")}
                  <OptRow label={t("settings.model")}>
                    <input
                      value={draft.settings.llm.model}
                      placeholder={t("settings.llmModelPh")}
                      onChange={(e) => patch("llm", "model", e.target.value)}
                    />
                  </OptRow>
                </div>
              )}

              {tab === "asr" && (
                <div className="opt-list">
                  <OptRow label={t("settings.svcUrl")}>
                    <input
                      value={draft.settings.asr.url}
                      placeholder={t("settings.asrUrlPh")}
                      onChange={(e) => patch("asr", "url", e.target.value)}
                    />
                  </OptRow>
                  {keyRow("asr")}
                </div>
              )}

              {tab === "tts" && (
                <div className="opt-list">
                  <OptRow label={t("settings.svcUrl")}>
                    <input
                      value={draft.settings.tts.url}
                      placeholder={t("settings.ttsUrlPh")}
                      onChange={(e) => patch("tts", "url", e.target.value)}
                    />
                  </OptRow>
                  {keyRow("tts")}
                  <OptRow label={t("settings.voice")}>
                    <input
                      value={draft.settings.tts.voice}
                      placeholder={t("settings.voicePh")}
                      onChange={(e) => patch("tts", "voice", e.target.value)}
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
                      onChange={(v) => patch("tts", "lang", v)}
                    />
                  </OptRow>
                </div>
              )}

              <p className="muted settings-note">{t("settings.note")}</p>
            </div>
          )}
        </div>
      </div>

      {/* 底部操作条：独立全宽容器，左返回 / 右保存 */}
      <footer className="footbar">
        <div className="footbar-inner">
          <button className="ghost" onClick={goBack}>
            {t("common.back")}
          </button>
          <div className="foot-right">
            {saved && <span className="saved-hint">{t("common.saved")}</span>}
            <button onClick={save} disabled={!dirty}>
              {t("common.save")}
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
              <button
                onClick={() => {
                  save();
                  navigate("title");
                }}
              >
                {t("settings.saveLeave")}
              </button>
              <button
                className="ghost"
                onClick={() => navigate("title")}
              >
                {t("settings.discardLeave")}
              </button>
              <button className="ghost" onClick={() => setConfirmLeave(false)}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
