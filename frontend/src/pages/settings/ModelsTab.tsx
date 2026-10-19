// 「模型」tab：LLM / ASR / TTS / Embedding 四个端点卡片（地址、密钥、模型、探测）。
// 原先这些都挤在 Settings.tsx 里，状态与辅助一并搬过来。
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useT } from "../../i18n";
import { getState, subscribe, update } from "../../lib/store";
import type { Settings as SettingsData } from "../../lib/types";
import { probeAsr, probeEmbedding, probeLlm, probeTts } from "../../services/probe";
import { uploadRefAudio } from "../../services/ttsClient";
import type { ProbeResult } from "../../services/probe";
import Button from "../../ui/Button";
import FieldRow from "../../ui/FieldRow";
import Hint from "../../ui/Hint";
import Select from "../../ui/Select";

type EndpointSection = "llm" | "asr" | "tts" | "embedding";

const URL_SCHEMES: Record<EndpointSection, string[]> = {
  llm: ["http:", "https:"],
  tts: ["http:", "https:"],
  // asr 自定义模式走 OpenAI HTTP 转写协议（内置模式不走 url）
  asr: ["http:", "https:"],
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
  /** 探测按钮的文案：**封闭短词汇表**，永不透传后端的原始错误串。
      定宽按钮里只能放这类短词（测试/…/0.8s/失败/未填/缺参考音/缺模型）；
      具体原因（HTTP 400、backend unreachable 之类）属于内部实现，留在日志里即可。 */
  const probeLabel = (sec: EndpointSection): { text: string; cls: string } => {
    const r = probes[sec];
    if (!r) return { text: t("settings.test"), cls: "" };
    if (r === "running") return { text: "…", cls: "probe-info" };
    const ms = /^(\d+)ms$/.exec(r.detail);
    if (ms) {
      const n = Number(ms[1]);
      return { text: n >= 1000 ? `${(n / 1000).toFixed(1)}s` : r.detail, cls: "probe-ok" };
    }
    if (r.detail === "unconfigured" || r.detail.startsWith("未配置服务地址")) {
      return { text: t("settings.testNeedUrl"), cls: "probe-err" };
    }
    if (r.detail === "未上传参考音频") return { text: t("settings.ttsNeedRef"), cls: "probe-err" };
    if (r.detail.startsWith("缺少模型")) return { text: t("settings.asrNeedModel"), cls: "probe-err" };
    return { text: t("settings.testFail"), cls: "probe-err" };
  };

  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState("");

  /** 上传参考音频：重复上传覆盖旧文件，成功后把文件名写回 state。 */
  const onPickRef = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许再次选同一个文件
    if (!file) return;
    setUploading(true);
    setUploadErr("");
    try {
      const res = await uploadRefAudio(file);
      update({
        settings: { ...settings, tts: { ...settings.tts, voice: res.name } },
      });
    } catch (err) {
      setUploadErr((err as Error).message || String(err));
    } finally {
      setUploading(false);
    }
  };

  const urlRow = (
    sec: EndpointSection,
    phKey: string,
    required = false,
    disabled = false,
  ): React.ReactNode => {
    // 地址有问题（格式错 / 必填为空）不在行内堆文字：输入框标红，
    // 测试按钮直接变成警示图标（悬停有原因），信息密度交给图标。
    const badUrl = !disabled && urlError(sec, settings[sec].url);
    const missing = !disabled && required && !settings[sec].url.trim();
    const warn = badUrl || missing;
    return (
      <FieldRow
        label={sec === "llm" ? t("settings.apiUrl") : t("settings.svcUrl")}
        required={required}
      >
        <input
          className={warn ? "invalid" : undefined}
          value={settings[sec].url}
          placeholder={disabled ? "—" : t(phKey)}
          disabled={disabled}
          onChange={(e) => patchEndpoint(sec, "url", e.target.value)}
        />
        <Button
          variant="ghost"
          className={`key-toggle row-btn probe-btn ${
            warn ? "probe-warn" : probeLabel(sec).cls
          }`}
          title={warn ? t(badUrl ? "settings.invalidUrl" : "settings.required") : undefined}
          onClick={() => runProbe(sec)}
          disabled={disabled || warn || probes[sec] !== undefined}
        >
          {warn ? "⚠" : probeLabel(sec).text}
        </Button>
      </FieldRow>
    );
  };

  // 返回目标与来源页一致：chat 进来回 chat，其余回 title。
  const patchEndpoint = (sec: EndpointSection, key: string, v: string): void => {
    update({
      settings: { ...settings, [sec]: { ...settings[sec], [key]: v } },
    });
  };

  const keyRow = (sec: EndpointSection, disabled = false) => (
    <FieldRow label={t("settings.apiKey")}>
      <input
        type={showKey[sec] ? "text" : "password"}
        value={settings[sec].key}
        disabled={disabled}
        onChange={(e) => patchEndpoint(sec, "key", e.target.value)}
      />
      <Button
        variant="ghost"
        className="key-toggle row-btn"
        disabled={disabled}
        onClick={() => setShowKey((s) => ({ ...s, [sec]: !s[sec] }))}
      >
        {showKey[sec] ? t("settings.hideKey") : t("settings.showKey")}
      </Button>
    </FieldRow>
  );
  return (
<div className="settings-cols">
{/* 每个小标题各自成格，与「通用」页一致（2 列网格里一格一组）。
    网格按行填充：第 1 行 LLM｜Embedding（各 3 行），第 2 行 ASR｜TTS（各 4 行）
    —— 同一行的卡片行数一致，两行内部各自等高。 */}
<section className="panel settings-col opt-list">
  <h3 className="opt-group">
    {t("settings.groups.llm")}
    <Hint text={t("settings.llmHint")} side="down" />
  </h3>
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
  </FieldRow>
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
  <h3 className="opt-group">
    {t("settings.groups.asr")}
    <Hint
      text={
        settings.asr.mode === "builtin"
          ? t("settings.asrBuiltinHint")
          : t("settings.asrHint")
      }
      side="down"
    />
  </h3>
  <FieldRow label={t("settings.asrMode")}>
    <Select
      value={settings.asr.mode}
      options={[
        { value: "builtin", label: t("settings.asrBuiltin") },
        { value: "openai", label: t("settings.asrOpenai") },
      ]}
      onChange={(v) => patchEndpoint("asr", "mode", v)}
    />
  </FieldRow>
  {urlRow("asr", "settings.asrUrlPh", false, settings.asr.mode === "builtin")}
  {keyRow("asr", settings.asr.mode === "builtin")}
  <FieldRow label={t("settings.model")}>
    <input
      value={settings.asr.model}
      disabled={settings.asr.mode === "builtin"}
      placeholder={
        settings.asr.mode === "builtin" ? "—" : t("settings.asrModelPh")
      }
      onChange={(e) => patchEndpoint("asr", "model", e.target.value)}
    />
  </FieldRow>
</section>
<section className="panel settings-col opt-list">
  <h3 className="opt-group">
    {t("settings.groups.tts")}
    <Hint text={t("settings.ttsHint")} side="down" />
  </h3>
  {urlRow("tts", "settings.ttsUrlPh")}
  {keyRow("tts")}
  <FieldRow label={t("settings.ttsRefAudio")} hint={t("settings.ttsRefAudioHint")}>
    <span className={`ref-name${settings.tts.voice ? "" : " muted"}`}>
      {settings.tts.voice || t("settings.ttsNotUploaded")}
    </span>
    <input
      ref={fileRef}
      type="file"
      accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg,.aac"
      hidden
      onChange={onPickRef}
    />
    {/* 与「显示/测试」同一套紧凑尺寸（key-toggle 提供字号与内边距） */}
    <Button
      variant="ghost"
      className="key-toggle row-btn"
      disabled={uploading}
      onClick={() => fileRef.current?.click()}
    >
      {uploading
        ? t("settings.ttsUploading")
        : settings.tts.voice
          ? t("settings.ttsReupload")
          : t("settings.ttsUpload")}
    </Button>
    {uploadErr && <span className="probe-err">{uploadErr}</span>}
  </FieldRow>
  <FieldRow label={t("settings.ttsRefText")}>
    <input
      value={settings.tts.prompt}
      placeholder={t("settings.ttsRefTextPh")}
      onChange={(e) => patchEndpoint("tts", "prompt", e.target.value)}
    />
  </FieldRow>
  {/* 合成语言不单独配置：跟随「通用」页的对话语言
      （见 i18n 的 resolveChatLang 与 services/ttsClient.ts）。 */}
</section>
</div>
  );
}
