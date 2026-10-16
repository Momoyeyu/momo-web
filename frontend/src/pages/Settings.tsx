// 设置页三段式（对照柚子社 config 结构）：
//   顶部 tab 条——独立全宽容器，页签均分铺满；
//   中部内容——双栏面板（底边对齐：底部行为钉底、中段留白为弹性区）；
//   底部操作条——返回按钮聚拢右下。
// 即改即生效：每次修改直接 update() 落盘（localStorage + 防抖 PUT
// /api/state），无草稿/保存概念——语言切换等立即生效。

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  getState,
  speakerName,
  subscribe,
  update,
} from "../lib/store";
import { getChatEngine } from "../chat/engineInstance";
import type {
  McpExtension,
  Settings as SettingsData,
} from "../lib/types";
import { fromRoute, navigate } from "../router";
import { useT, tFor, LANGS } from "../i18n";
import {
  probeAsr,
  probeEmbedding,
  probeLlm,
  probeTts,
} from "../services/probe";
import type { ProbeResult } from "../services/probe";
import { probeExtension } from "../services/extClient";
import type { ExtProbeResult } from "../services/extClient";
import { CARD_PAGE_SIZE, clampPage } from "../lib/paging";
import FieldRow from "../ui/FieldRow";
import Slider from "../ui/Slider";
import Switch from "../ui/Switch";
import Button from "../ui/Button";
import AvatarPanel from "./panels/Avatar";
import Hint from "../ui/Hint";
import IconButton from "../ui/IconButton";
import Pager from "../ui/Pager";
import Select from "../ui/Select";
import MemoryPanel from "./panels/Memory";
import "../styles/settings.css";

type EndpointSection = "llm" | "asr" | "tts" | "embedding";
type Section = "general" | "models" | "memory" | "extend";

const TABS: Section[] = [
  "general",
  "models",
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

import DialogPreview from "./settings/DialogPreview";
import ExtConfigModal from "./settings/ExtConfigModal";
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
  const [extQuery, setExtQuery] = useState("");
  const [extPage, setExtPage] = useState(0);
  // 连接状态点：下标 → 探测结果（"running" = 进行中）。
  const [extProbes, setExtProbes] = useState<
    Record<number, ExtProbeResult | "running">
  >({});
  // 语音输出开关：与 chat 工具条同一个开关（引擎运行时态）。
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

  const PROBES: Record<
    EndpointSection,
    (s: SettingsData) => Promise<ProbeResult>
  > = {
    llm: (s) => probeLlm(s.llm),
    asr: (s) => probeAsr(s.asr),
    tts: (s) => probeTts(s.tts),
    embedding: (s) => probeEmbedding(s.embedding),
  };

  // 探测结果直接显示在按钮上，固定展示 PROBE_HOLD_MS 后复原；期间不可再点。
  const PROBE_HOLD_MS = 2500;
  const probeTimers = useRef<Partial<Record<EndpointSection, number>>>({});
  useEffect(
    () => () => {
      for (const id of Object.values(probeTimers.current)) clearTimeout(id);
    },
    [],
  );

  const runProbe = (sec: EndpointSection): void => {
    if (probes[sec] !== undefined) return;
    setProbes((p) => ({ ...p, [sec]: "running" }));
    void PROBES[sec](settings).then((r) => {
      setProbes((p) => ({ ...p, [sec]: r }));
      clearTimeout(probeTimers.current[sec]);
      probeTimers.current[sec] = window.setTimeout(() => {
        setProbes((p) => {
          const n = { ...p };
          delete n[sec];
          return n;
        });
      }, PROBE_HOLD_MS);
    });
  };

  /**
   * 按钮内联文案：running→「…」，否则 ✓/✗ + 简短结果。
   *
   * 只显示「值」不带说明，好让定宽按钮容得下最坏一档：
   *   延迟 ≥1s 记成 1.2s（否则 1234ms 会把按钮撑破）
   *   HTTP 状态码只留数字（✗ 404 比 ✗ HTTP 404 短，且与 ✓ 122ms 对称）
   */
  const probeLabel = (sec: EndpointSection): { text: string; cls: string } => {
    const r = probes[sec];
    if (!r) return { text: t("settings.test"), cls: "" };
    if (r === "running") return { text: "…", cls: "probe-info" };
    const ms = /^(\d+)ms$/.exec(r.detail);
    const detail = ms
      ? Number(ms[1]) >= 1000
        ? `${(Number(ms[1]) / 1000).toFixed(1)}s`
        : r.detail
      : r.detail === "unconfigured"
        ? t("settings.testNeedUrl")
        : /^(unreachable|timeout|connect failed|bad url|closed)/.test(r.detail)
          ? t("settings.testFail")
          : r.detail.replace(/^HTTP /, "");
    return {
      text: `${r.ok ? "✓" : "✗"} ${detail}`,
      cls: r.ok ? "probe-ok" : "probe-err",
    };
  };

  const urlRow = (
    sec: EndpointSection,
    phKey: string,
    required = false,
  ): React.ReactNode => (
    <FieldRow
      label={sec === "llm" ? t("settings.apiUrl") : t("settings.svcUrl")}
      required={required}
    >
      <input
        className={urlError(sec, settings[sec].url) ? "invalid" : undefined}
        value={settings[sec].url}
        placeholder={t(phKey)}
        onChange={(e) => patchEndpoint(sec, "url", e.target.value)}
      />
      <Button
        variant="ghost"
        className={`key-toggle row-btn probe-btn ${probeLabel(sec).cls}`}
        onClick={() => runProbe(sec)}
        disabled={probes[sec] !== undefined}
      >
        {probeLabel(sec).text}
      </Button>
      {urlError(sec, settings[sec].url) ? (
        <span className="probe-err">{t("settings.invalidUrl")}</span>
      ) : (
        required &&
        !settings[sec].url.trim() && (
          <span className="probe-err">{t("settings.required")}</span>
        )
      )}
    </FieldRow>
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

  // 检索 + 分页（与 Live2D 面板同构：过滤命中集分页，索引映射回原清单）
  const extHits = settings.extensions
  .map((ext, i) => ({ ext, i }))
  .filter(({ ext }) =>
  (ext.name || "").toLowerCase().includes(extQuery.trim().toLowerCase()),
  );
  const extPg = clampPage(extPage, extHits.length, CARD_PAGE_SIZE);
  const extSlice = extHits.slice(
  extPg.page * CARD_PAGE_SIZE,
  (extPg.page + 1) * CARD_PAGE_SIZE,
  );

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
    <FieldRow label={t("settings.apiKey")}>
      <input
        type={showKey[sec] ? "text" : "password"}
        value={settings[sec].key}
        onChange={(e) => patchEndpoint(sec, "key", e.target.value)}
      />
      <Button
        variant="ghost"
        className="key-toggle row-btn"
        onClick={() => setShowKey((s) => ({ ...s, [sec]: !s[sec] }))}
      >
        {showKey[sec] ? t("settings.hideKey") : t("settings.showKey")}
      </Button>
    </FieldRow>
  );

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

              {tab === "models" && (
                <>
                <div className="settings-cols">
                {/* 每个小标题各自成格，与「通用」页一致（2 列网格里一格一组）。
                    网格按行填充，故顺序为：第 1 行 LLM｜ASR，第 2 行 Embedding｜TTS，
                    与原「左栏 LLM+Embedding / 右栏 ASR+TTS」的位置一致。 */}
                <section className="panel settings-col opt-list">
                  <h3 className="opt-group">{t("settings.groups.llm")}</h3>
                  {urlRow("llm", "settings.llmUrlPh", true)}
                  {keyRow("llm")}
                  <FieldRow label={t("settings.model")} required>
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
                  </FieldRow>
                </section>
                <section className="panel settings-col opt-list">
                  <h3 className="opt-group">{t("settings.groups.asr")}</h3>
                  {urlRow("asr", "settings.asrUrlPh")}
                  {keyRow("asr")}
                </section>
                <section className="panel settings-col opt-list">
                  <h3 className="opt-group">
                    {t("settings.groups.embedding")}
                  </h3>
                  {urlRow("embedding", "settings.embUrlPh")}
                  {keyRow("embedding")}
                  <FieldRow label={t("settings.model")}>
                    <input
                      value={settings.embedding.model}
                      placeholder={t("settings.embModelPh")}
                      onChange={(e) =>
                        patchEndpoint("embedding", "model", e.target.value)
                      }
                    />
                  </FieldRow>
                </section>
                <section className="panel settings-col opt-list">
                  <h3 className="opt-group">{t("settings.groups.tts")}</h3>
                  {urlRow("tts", "settings.ttsUrlPh")}
                  {keyRow("tts")}
                  <FieldRow label={t("settings.voice")}>
                    <input
                      value={settings.tts.voice}
                      placeholder={t("settings.voicePh")}
                      onChange={(e) => patchEndpoint("tts", "voice", e.target.value)}
                    />
                  </FieldRow>
                  {/* 合成语言不单独配置：跟随「通用」页的对话语言
                      （见 i18n 的 resolveChatLang 与 services/ttsClient.ts）。 */}
                </section>
                </div>
                </>
              )}

              {tab === "extend" && (
              /* 双栏：左 Live2D（原「形象」tab 唯一剩下的配置）、右 MCP 拓展 */
              <div className="settings-cols">
              <section className="panel panel-stack">
              <h3 className="opt-group">
              {t("settings.groups.avatar")}
              <span className="req">*</span>
              </h3>
              <AvatarPanel />
              </section>
              <section className="panel panel-stack settings-col ext-panel">
                  <div className="panel-title-row">
                    <h3 className="opt-group">
                      {t("settings.groups.extensions")}
                    </h3>
                    <Hint text={t("settings.extHint")} side="down" />
                  </div>
                  <div className="list-toolbar">
                  <input
                  className="list-search"
                  placeholder={t("settings.extSearchPh")}
                  value={extQuery}
                  onChange={(e) => {
                  setExtQuery(e.target.value);
                  setExtPage(0);
                  }}
                  />
                  <IconButton
                  icon="plus"
                  label={t("settings.extAdd")}
                  tip={t("settings.extAdd")}
                  onClick={() => setExtEditing(-1)}
                  />
                  </div>
                  <div className="list-body">
                  {extSlice.length === 0 && (
                  <p className="muted">{t("settings.extEmpty")}</p>
                  )}
                  {extSlice.map(({ ext, i }) => (
                  <div className="list-item ext-row" key={i}>
                        <span className="ext-name">
                          {ext.name || t("settings.extUnnamed")}
                        </span>
                        <span className="ext-badge">{ext.transport}</span>
                        <Switch
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
<IconButton
                            icon="edit"
                            size="sm"
                            label={t("common.edit")}
                            tip={t("common.edit")}
                            onClick={() => setExtEditing(i)}
                          />
                          <IconButton
                            icon="trash"
                            size="sm"
                            danger
                            label={t("common.del")}
                            tip={t("common.del")}
                            onClick={() =>
                              patchExtensions(
                                settings.extensions.filter((_, j) => j !== i),
                              )
                            }
                          />
                      </div>
                    ))}
                  </div>
                  <div className="col-foot">
                    <div className="list-foot">
                      <Pager page={extPg.page} pages={extPg.pages} onChange={setExtPage} />
                    </div>
                  </div>
                </section>
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
            <Button variant="ghost" onClick={() => navigate(backRoute)}>
              {backLabel}
            </Button>
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
