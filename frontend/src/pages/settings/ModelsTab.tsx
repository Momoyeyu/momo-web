// 「模型」tab：LLM / ASR / TTS / Embedding 四个端点卡片（地址、密钥、模型、探测）。
// 原先这些都挤在 Settings.tsx 里，状态与辅助一并搬过来。
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useT } from "../../i18n";
import { getState, subscribe, update } from "../../lib/store";
import type { Settings as SettingsData } from "../../lib/types";
import { probeAsr, probeEmbedding, probeLlm, probeTts } from "../../services/probe";
import type { ProbeResult } from "../../services/probe";
import Button from "../../ui/Button";
import FieldRow from "../../ui/FieldRow";

type EndpointSection = "llm" | "asr" | "tts" | "embedding";

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


export default function ModelsTab() {
  const t = useT();
  const settings = useSyncExternalStore(subscribe, getState).settings;

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
  // 语音输出开关：与 chat 工具条同一个开关（引擎运行时态）。

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
  const patchEndpoint = (sec: EndpointSection, key: string, v: string): void => {
    update({
      settings: { ...settings, [sec]: { ...settings[sec], [key]: v } },
    });
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
  );
}
