// 设置页三段式（对照柚子社 config 结构）：
//   顶部 tab 条——独立全宽容器，页签均分铺满；
//   中部内容——双栏面板（底边对齐：底部行为钉底、中段留白为弹性区）；
//   底部操作条——返回按钮聚拢右下。
// 即改即生效：每次修改直接 update() 落盘（localStorage + 防抖 PUT
// /api/state），无草稿/保存概念——语言切换等立即生效。

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  getState,
  personaName,
  subscribe,
  update,
} from "../lib/store";
import { getChatEngine } from "../chat/engine";
import { SentenceSplitter } from "../chat/sentences";
import { charsPerSec, dwellMs, sentencePauseMs } from "../chat/pacing";
import type {
  McpExtension,
  Settings as SettingsData,
} from "../lib/types";
import { fromRoute, navigate } from "../router";
import { useT, LANGS } from "../i18n";
import {
  probeAsr,
  probeEmbedding,
  probeLlm,
  probeTts,
} from "../services/probe";
import type { ProbeResult } from "../services/probe";
import { probeExtension } from "../services/extClient";
import type { ExtProbeResult } from "../services/extClient";
import { LIST_PAGE_SIZE, clampPage } from "../lib/paging";
import { parseMcpJson } from "../lib/mcpJson";
import Pager from "../ui/Pager";
import Select from "../ui/Select";
import PersonaPanel from "./Persona";
import MemoryPanel from "./Memory";
import AvatarPanel from "./Avatar";
import "../styles/settings.css";

type EndpointSection = "llm" | "asr" | "tts" | "embedding";
type Section = "general" | "models" | "persona" | "memory" | "extend";

const TABS: Section[] = [
  "general",
  "models",
  "persona",
  "memory",
  "extend",
];

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
  top,
  children,
}: {
  label: string;
  /** 控件末尾小字（如滑块当前值/未配置提示）。 */
  extra?: React.ReactNode;
  /** 必填项：标签后加 * 标记。 */
  required?: boolean;
  /** 多行控件（键值对编辑器）：标签顶对齐而非居中。 */
  top?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`opt-row${top ? " top" : ""}`}>
      <span className="opt-label">
        {label}
        {required && <span className="req">*</span>}
      </span>
      <div className="opt-ctl">
        {children}
        {extra && <span className="opt-extra">{extra}</span>}
      </div>
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
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
    >
      <span className="knob" />
    </button>
  );
}

/**
 * 对话框预览：与 chat 同一套节奏换算——按文字速度逐字上屏、
 * 按切句速度驻留+停顿，多句循环播放（预览无 TTS，走驻留路径）。
 */
function DialogPreview({
  name,
  sample,
  opacity,
  textSpeed,
  sentenceSpeed,
}: {
  name: string;
  sample: string;
  opacity: number;
  textSpeed: number;
  sentenceSpeed: number;
}) {
  const [text, setText] = useState("");

  useEffect(() => {
    const splitter = new SentenceSplitter();
    const sentences = splitter.push(sample);
    const tail = splitter.flush();
    if (tail) sentences.push(tail);
    if (!sentences.length) return;
    let idx = 0;
    let reveal = 0;
    let doneAt = 0;
    let pausedUntil = 0;
    const timer = window.setInterval(() => {
      const now = performance.now();
      if (now < pausedUntil) return;
      const cur = sentences[idx];
      const rate = charsPerSec(textSpeed);
      reveal =
        rate === Infinity ? cur.length : Math.min(cur.length, reveal + rate * 0.04);
      if (reveal >= cur.length) {
        if (!doneAt) doneAt = now;
        if (now - doneAt >= dwellMs(sentenceSpeed, cur.length)) {
          idx = (idx + 1) % sentences.length;
          reveal = 0;
          doneAt = 0;
          pausedUntil = now + sentencePauseMs(sentenceSpeed);
          return; // 停顿时段保持上一句驻留，不清空
        }
      }
      setText(cur.slice(0, Math.floor(reveal)));
    }, 40);
    return () => window.clearInterval(timer);
  }, [sample, textSpeed, sentenceSpeed]);

  return (
    <div
      className="dialog-preview"
      style={{ "--dialog-alpha": opacity / 100 } as React.CSSProperties}
    >
      <div className="dialog-box">
        <div className="nameplate">{name}</div>
        <div className="subtitle">{text}</div>
      </div>
    </div>
  );
}

/* ---- 拓展配置弹窗（prototype/setting：居中 modal，背景变暗、点背景丢弃） ---- */

/** http 端点合法性：空=未填（由必填另行提示），非空必须 http(s)://。 */
function extEndpointError(url: string): boolean {
  const v = url.trim();
  if (!v) return false;
  try {
    return !["http:", "https:"].includes(new URL(v).protocol);
  } catch {
    return true;
  }
}

/** 弹窗表单草稿：args/env/headers 用文本/键值对形态便于编辑，保存时归一。 */
interface ExtForm {
  name: string;
  transport: McpExtension["transport"];
  enabled: boolean;
  command: string;
  /** stdio 参数：空格分隔文本，保存时拆数组。 */
  argsText: string;
  envPairs: [string, string][];
  endpoint: string;
  headerPairs: [string, string][];
}

function extToForm(ext: McpExtension): ExtForm {
  return {
    name: ext.name,
    transport: ext.transport,
    enabled: ext.enabled,
    command: ext.command,
    argsText: ext.args.join(" "),
    envPairs: Object.entries(ext.env),
    endpoint: ext.endpoint,
    headerPairs: Object.entries(ext.headers),
  };
}

function formToExt(f: ExtForm): McpExtension {
  const dict = (pairs: [string, string][]): Record<string, string> =>
    Object.fromEntries(
      pairs.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]),
    );
  return {
    name: f.name.trim(),
    transport: f.transport,
    enabled: f.enabled,
    command: f.command.trim(),
    args: f.argsText.split(/\s+/).filter(Boolean),
    env: dict(f.envPairs),
    endpoint: f.endpoint.trim(),
    headers: dict(f.headerPairs),
  };
}

/** 校验：名称必填；stdio 命令必填；http 端点必填且 http(s)://。 */
function extFormValid(f: ExtForm): boolean {
  if (!f.name.trim()) return false;
  if (f.transport === "stdio") return f.command.trim() !== "";
  return f.endpoint.trim() !== "" && !extEndpointError(f.endpoint);
}

/** KEY = value 键值对编辑器：行可增删（env / headers 共用）。 */
function KvEditor({
  pairs,
  onChange,
  addLabel,
}: {
  pairs: [string, string][];
  onChange: (pairs: [string, string][]) => void;
  addLabel: string;
}) {
  const t = useT();
  const setPair = (i: number, k: string, v: string): void =>
    onChange(pairs.map((p, j) => (j === i ? ([k, v] as [string, string]) : p)));
  return (
    <div className="kv-list">
      {pairs.map(([k, v], i) => (
        <div className="kv-row" key={i}>
          <input
            className="kv-key"
            value={k}
            placeholder={t("settings.extKvKey")}
            onChange={(e) => setPair(i, e.target.value, v)}
          />
          <span className="kv-eq">=</span>
          <input
            className="kv-val"
            value={v}
            placeholder={t("settings.extKvVal")}
            onChange={(e) => setPair(i, k, e.target.value)}
          />
          <button
            type="button"
            className="ghost small danger"
            onClick={() => onChange(pairs.filter((_, j) => j !== i))}
          >
            {t("common.del")}
          </button>
        </div>
      ))}
      <button
        type="button"
        className="ghost small kv-add"
        onClick={() => onChange([...pairs, ["", ""]])}
      >
        {addLabel}
      </button>
    </div>
  );
}

/**
 * MCP server 配置弹窗：transport 下拉切换差分字段（stdio=命令/参数/环境变量，
 * http=端点/请求头）；顶部「从 JSON 填入」粘贴标准 MCP 配置——单条填表、
 * 多条直接逐个导入列表；点遮罩或取消关闭（未保存丢弃）。
 */
function ExtConfigModal({
  initial,
  onSave,
  onImport,
  onClose,
}: {
  initial: McpExtension;
  onSave: (ext: McpExtension) => void;
  /** JSON 多条导入：直接进列表并关弹窗（草稿丢弃）。 */
  onImport: (exts: McpExtension[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [form, setForm] = useState<ExtForm>(() => extToForm(initial));
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonErr, setJsonErr] = useState(false);
  const patch = (p: Partial<ExtForm>): void =>
    setForm((f) => ({ ...f, ...p }));

  const applyJson = (): void => {
    try {
      const exts = parseMcpJson(jsonText);
      if (exts.length === 1) {
        setForm(extToForm(exts[0]));
        setJsonText("");
        setJsonErr(false);
        setJsonOpen(false);
      } else {
        onImport(exts);
      }
    } catch {
      setJsonErr(true); // 解析失败：表单报错，不导入不污染
    }
  };

  const endpointErr = extEndpointError(form.endpoint);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="panel ext-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ext-modal-head">
          <h3 className="opt-group">{t("settings.extCfgTitle")}</h3>
          <button
            type="button"
            className="ghost small"
            onClick={() => {
              setJsonOpen((o) => !o);
              setJsonErr(false);
            }}
          >
            {t("settings.extJsonBtn")}
          </button>
        </div>
        {jsonOpen && (
          <div className="ext-json">
            <textarea
              rows={5}
              value={jsonText}
              placeholder={t("settings.extJsonPh")}
              onChange={(e) => {
                setJsonText(e.target.value);
                setJsonErr(false);
              }}
            />
            <div className="ext-json-ops">
              {jsonErr && (
                <span className="probe-err">{t("settings.extJsonErr")}</span>
              )}
              <button
                type="button"
                className="small"
                disabled={!jsonText.trim()}
                onClick={applyJson}
              >
                {t("settings.extJsonApply")}
              </button>
            </div>
          </div>
        )}
        <div className="opt-list">
          <OptRow label={t("settings.extName")} required>
            <input
              value={form.name}
              placeholder={t("settings.extNamePh")}
              onChange={(e) => patch({ name: e.target.value })}
            />
            {!form.name.trim() && (
              <span className="probe-err">{t("settings.required")}</span>
            )}
          </OptRow>
          <OptRow label={t("settings.extTransport")}>
            <Select
              value={form.transport}
              options={[
                {
                  value: "http",
                  label: t("settings.extTransports.http"),
                },
                {
                  value: "stdio",
                  label: t("settings.extTransports.stdio"),
                },
              ]}
              onChange={(v) =>
                patch({ transport: v as McpExtension["transport"] })
              }
            />
          </OptRow>
          {form.transport === "stdio" ? (
            <>
              <OptRow label={t("settings.extCommand")} required>
                <input
                  className={form.command.trim() ? undefined : "invalid"}
                  value={form.command}
                  placeholder={t("settings.extCommandPh")}
                  onChange={(e) => patch({ command: e.target.value })}
                />
                {!form.command.trim() && (
                  <span className="probe-err">{t("settings.required")}</span>
                )}
              </OptRow>
              <OptRow label={t("settings.extArgs")}>
                <input
                  value={form.argsText}
                  placeholder={t("settings.extArgsPh")}
                  onChange={(e) => patch({ argsText: e.target.value })}
                />
              </OptRow>
              <OptRow label={t("settings.extEnv")} top>
                <KvEditor
                  pairs={form.envPairs}
                  onChange={(envPairs) => patch({ envPairs })}
                  addLabel={t("settings.extEnvAdd")}
                />
              </OptRow>
            </>
          ) : (
            <>
              <OptRow label={t("settings.extEndpoint")} required>
                <input
                  className={endpointErr ? "invalid" : undefined}
                  value={form.endpoint}
                  placeholder={t("settings.extEndpointPh")}
                  onChange={(e) => patch({ endpoint: e.target.value })}
                />
                {endpointErr ? (
                  <span className="probe-err">{t("settings.invalidUrl")}</span>
                ) : (
                  !form.endpoint.trim() && (
                    <span className="probe-err">{t("settings.required")}</span>
                  )
                )}
              </OptRow>
              <OptRow label={t("settings.extHeaders")} top>
                <KvEditor
                  pairs={form.headerPairs}
                  onChange={(headerPairs) => patch({ headerPairs })}
                  addLabel={t("settings.extHeaderAdd")}
                />
              </OptRow>
            </>
          )}
          <OptRow label={t("settings.extEnabled")}>
            <OptSwitch
              on={form.enabled}
              onChange={(v) => patch({ enabled: v })}
            />
          </OptRow>
        </div>
        <div className="ext-actions">
          <button type="button" className="ghost key-toggle" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="key-toggle"
            disabled={!extFormValid(form)}
            onClick={() => onSave(formToExt(form))}
          >
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
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
  // 拓展：null=无弹窗，-1=新增，>=0=编辑第 i 条；表单草稿归弹窗组件管。
  const [extEditing, setExtEditing] = useState<number | null>(null);
  const [extPage, setExtPage] = useState(0);
  // 连接状态点：下标 → 探测结果（"running" = 进行中）。
  const [extProbes, setExtProbes] = useState<
    Record<number, ExtProbeResult | "running">
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

  // ---- 拓展 · MCP ----

  const patchExtensions = (list: McpExtension[]): void => {
    update({ settings: { ...settings, extensions: list } });
  };

  // 连接状态：tab 打开（或清单变化）时对 enabled 记录各探测一次，
  // 结果只影响状态点，失败不阻塞 UI。
  useEffect(() => {
    if (tab !== "extend") return;
    let alive = true;
    setExtProbes({});
    settings.extensions.forEach((ext, i) => {
      if (!ext.enabled) return;
      setExtProbes((p) => ({ ...p, [i]: "running" }));
      void probeExtension(ext).then((r) => {
        if (alive) setExtProbes((p) => ({ ...p, [i]: r }));
      });
    });
    return () => {
      alive = false;
    };
  }, [tab, settings.extensions]);

  const extPg = clampPage(extPage, settings.extensions.length);
  const extSlice = settings.extensions
    .map((ext, i) => ({ ext, i }))
    .slice(extPg.page * LIST_PAGE_SIZE, (extPg.page + 1) * LIST_PAGE_SIZE);

  const blankExt = (): McpExtension => ({
    name: "",
    transport: "http",
    enabled: true,
    command: "",
    args: [],
    env: {},
    endpoint: "",
    headers: {},
  });

  const saveExt = (ext: McpExtension): void => {
    if (extEditing === null) return;
    const list = [...settings.extensions];
    if (extEditing >= 0) list[extEditing] = ext;
    else list.push(ext);
    patchExtensions(list);
    setExtEditing(null);
  };

  /** JSON 多条导入：逐条追加进列表（弹窗内草稿随之丢弃）。 */
  const importExts = (exts: McpExtension[]): void => {
    patchExtensions([...settings.extensions, ...exts]);
    setExtEditing(null);
  };

  /** 行内状态点：未启用灰点 / 探测中 / ●成功(n tools) / ✗失败。 */
  const extDot = (i: number, ext: McpExtension): React.ReactNode => {
    if (!ext.enabled) {
      return (
        <span className="ext-dot off" title={t("settings.extStOff")}>
          ○
        </span>
      );
    }
    const r = extProbes[i];
    if (!r || r === "running") {
      return (
        <span className="ext-dot wait" title={t("settings.extStRun")}>
          …
        </span>
      );
    }
    if (r.ok) {
      const label = t("settings.extStOk", { n: String(r.tools) });
      return (
        <span className="ext-dot ok" title={label}>
          ● {label}
        </span>
      );
    }
    return (
      <span
        className="ext-dot err"
        title={r.error || t("settings.extStFail")}
      >
        ✗ {t("settings.extStFail")}
      </span>
    );
  };

  const keyRow = (sec: EndpointSection) => (
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
            <MemoryPanel />
          ) : (
            <div className="settings-body">
              {tab === "general" && (
                <div className="settings-cols">
                <section className="panel settings-col opt-list">
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
                </section>
                {/* 对话框设置子组：三滑块 + 预览同组联动，预览钉在面板底缘。 */}
                <section className="panel settings-col">
                  <h3 className="opt-group">
                    {t("settings.groups.dialog")}
                  </h3>
                  <div className="opt-list">
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
                  <OptRow
                    label={t("settings.textSpeed")}
                    extra={`${settings.general.textSpeed}%`}
                  >
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      style={rangeFill(settings.general.textSpeed)}
                      value={settings.general.textSpeed}
                      onChange={(e) =>
                        patchGeneral({ textSpeed: Number(e.target.value) })
                      }
                    />
                  </OptRow>
                  <OptRow
                    label={t("settings.sentenceSpeed")}
                    extra={`${settings.general.sentenceSpeed}%`}
                  >
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      style={rangeFill(settings.general.sentenceSpeed)}
                      value={settings.general.sentenceSpeed}
                      onChange={(e) =>
                        patchGeneral({ sentenceSpeed: Number(e.target.value) })
                      }
                    />
                  </OptRow>
                  </div>
                  {/* 对话框实时预览：多句循环，逐字上屏 + 按切句速度换句 */}
                  <div className="col-foot">
                    <DialogPreview
                      name={state.persona.name || personaName()}
                      sample={t("settings.previewSample")}
                      opacity={settings.general.dialogOpacity}
                      textSpeed={settings.general.textSpeed}
                      sentenceSpeed={settings.general.sentenceSpeed}
                    />
                  </div>
                </section>
                </div>
              )}

              {tab === "models" && (
                <>
                <div className="settings-cols">
                <section className="panel settings-col opt-list">
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

                  <h3 className="opt-group">
                    {t("settings.groups.embedding")}
                  </h3>
                  {urlRow("embedding", "settings.embUrlPh")}
                  {keyRow("embedding")}
                  <OptRow label={t("settings.model")}>
                    <input
                      value={settings.embedding.model}
                      placeholder={t("settings.embModelPh")}
                      onChange={(e) =>
                        patchEndpoint("embedding", "model", e.target.value)
                      }
                    />
                  </OptRow>
                </section>
                <section className="panel settings-col opt-list">
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

                </section>
                </div>
                <section className="panel settings-full">
                  <h3 className="opt-group">
                    {t("settings.groups.avatar")}
                    <span className="req">*</span>
                  </h3>
                  <AvatarPanel />
                </section>
                </>
              )}

              {tab === "extend" && (
                /* 拓展是设置页唯一单栏页：整行通宽列表，编辑走居中弹窗。 */
                <section className="panel settings-col ext-panel">
                  <h3 className="opt-group">
                    {t("settings.groups.extensions")}
                  </h3>
                  <p className="muted ext-hint">{t("settings.extHint")}</p>
                  <div className="ext-list col-grow">
                    {extSlice.map(({ ext, i }) => (
                      <div className="ext-row" key={i}>
                        <span className="ext-name">
                          {ext.name || t("settings.extUnnamed")}
                        </span>
                        <span className="ext-badge">{ext.transport}</span>
                        <OptSwitch
                          on={ext.enabled}
                          onChange={(v) =>
                            patchExtensions(
                              settings.extensions.map((x, j) =>
                                j === i ? { ...x, enabled: v } : x,
                              ),
                            )
                          }
                        />
                        {extDot(i, ext)}
                        <button
                          type="button"
                          className="ghost small"
                          onClick={() => setExtEditing(i)}
                        >
                          {t("common.edit")}
                        </button>
                        <button
                          type="button"
                          className="ghost small danger"
                          onClick={() =>
                            patchExtensions(
                              settings.extensions.filter((_, j) => j !== i),
                            )
                          }
                        >
                          {t("common.del")}
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="col-foot">
                    <button
                      type="button"
                      className="ghost ext-add"
                      onClick={() => setExtEditing(-1)}
                    >
                      {t("settings.extAdd")}
                    </button>
                    <div className="ext-pagerline">
                      <Pager
                        page={extPg.page}
                        pages={extPg.pages}
                        onChange={setExtPage}
                      />
                    </div>
                  </div>
                </section>
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

      {/* 拓展配置弹窗：背景变暗，点背景/取消丢弃未保存内容 */}
      {extEditing !== null && (
        <ExtConfigModal
          initial={
            extEditing >= 0 ? settings.extensions[extEditing] : blankExt()
          }
          onSave={saveExt}
          onImport={importExts}
          onClose={() => setExtEditing(null)}
        />
      )}
    </div>
  );
}
