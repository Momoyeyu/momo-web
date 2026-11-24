import { ttsEndpoint } from "../../lib/asr";
// 「模型」tab：LLM / TTS 两个服务配置卡片（地址、密钥、模型、探测）。
// 原先这些都挤在 Settings.tsx 里，状态与辅助一并搬过来。
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useT } from "../../i18n";
import { getState, subscribe, update } from "../../lib/store";
import { probeLlm } from "../../services/probe";
import { meetingIdentity } from "../../services/meetingClient";
import { desktop } from "../../services/runtime";
import { uploadRefAudio } from "../../services/ttsClient";
import { auditionVoice, invalidateWarmup, warmVoice } from "../../services/ttsWarmup";
import { useRoute } from "../../router";
import type { ProbeResult } from "../../services/probe";
import Button from "../../ui/Button";
import IconButton from "../../ui/IconButton";
import ProbeButton from "./ProbeButton";
import FieldRow from "../../ui/FieldRow";
import Hint from "../../ui/Hint";
import Switch from "../../ui/Switch";
import Select from "../../ui/Select";
import {introRestricted,verifyIntro,useIntro} from "../../services/introClient";
import { supportsThinking } from "../../lib/thinking";

type EndpointSection = "llm" | "tts";

const URL_SCHEMES: Record<EndpointSection, string[]> = {
  llm: ["http:", "https:"],
  tts: ["http:", "https:"],
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


export default function ModelsTab({ section }: { section: EndpointSection }) {
  const t = useT();
  const intro=useIntro();
  const saved = useSyncExternalStore(subscribe, getState).settings;
  const [draft, setDraft] = useState(saved.llm);
  const firstSetup = section === "llm" && intro.data?.phase === "setup";
  const settings = firstSetup ? {...saved, llm: draft} : saved;

  const endpoint = {llm: settings.llm, tts: ttsEndpoint(settings.tts)};
  const indexTts = settings.tts.engine === "index-tts";
  const request = useRef<AbortController | null>(null);
  const voiceEdited = useRef(false);
  const route = useRoute();
  const signature = section === "llm"
    ? JSON.stringify([section, settings.llm.url, settings.llm.key, settings.llm.model, settings.llm.thinking])
    : JSON.stringify([section, settings.tts.engine, endpoint.tts, settings.tts.voice, settings.tts.prompt, settings.general.chatLang, settings.general.lang]);
  const [showKey, setShowKey] = useState(false);
  const [probe, setProbe] = useState<{signature: string; result: ProbeResult | "running"}>();
  const result = probe?.signature === signature ? probe.result : undefined;
  const running = result === "running";

  useEffect(() => {
    setProbe(current => current?.signature === signature ? current : undefined);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [route, signature]);

  async function runProbe() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setProbe({signature, result: "running"});
    try {
      let response: ProbeResult;
      if (section === "tts") {
        response = await auditionVoice(controller.signal);
      } else if (introRestricted()) {
        await verifyIntro(firstSetup ? settings.llm : undefined);
        response = {ok: true, detail: ""};
      } else {
        response = await probeLlm(settings.llm, controller.signal);
      }
      if (!controller.signal.aborted) setProbe({signature, result: response});
    } catch {
      if (!controller.signal.aborted) setProbe({signature, result: {ok: false, detail: ""}});
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  function resultDetail(): string | undefined {
    if (!result || result === "running") return;
    if (result.ok) {
      const ms = /^(\d+)ms$/.exec(result.detail)?.[1];
      return ms ? t("settings.probe.latency", {ms}) : undefined;
    }
    if (result.detail === "unconfigured" || result.detail.startsWith("未配置服务地址")) return t("settings.testNeedUrl");
    if (result.detail === "未上传参考音频") return t("settings.ttsNeedRef");
    if (result.detail === "timeout") return t("config.timeout");
    if (["unreachable", "backend unreachable"].includes(result.detail)) return t("config.unreachable");
    if (result.detail === "invalid response") return t("config.invalidResponse");
    if (/^HTTP \d{3}$/.test(result.detail)) return t("settings.probe.http", {code: result.detail});
  }

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
      const current = getState().settings;
      request.current?.abort();
      request.current = null;
      invalidateWarmup();
      update({settings: { ...current, tts: { ...current.tts, voice: res.name } }});
      if (desktop() || meetingIdentity()) warmVoice();
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
    const badUrl = !disabled && urlError(sec, endpoint[sec].url);
    const missing = !disabled && required && !endpoint[sec].url.trim();
    const warn = badUrl || missing;
    return (
      <FieldRow
        label={sec === "llm" ? t("settings.apiUrl") : t("settings.svcUrl")}
        required={required}
      >
        <input
          className={warn ? "invalid" : undefined}
          value={endpoint[sec].url}
          placeholder={disabled ? "—" : t(phKey)}
          disabled={disabled || (firstSetup && running)}
          onChange={(e) => patchEndpoint(sec, "url", e.target.value)}
        />
        <ProbeButton label={t(sec === "tts" ? "settings.audition" : "settings.test")}
          idleIcon={sec === "tts" ? "play" : "focus"}
          state={warn || disabled ? "unavailable" : running ? "running" : result ? result.ok ? "passed" : "failed" : "idle"}
          detail={warn ? t(badUrl ? "settings.invalidUrl" : "settings.testNeedUrl") : resultDetail()}
          onClick={() => void runProbe()}/>
      </FieldRow>
    );
  };

  // 返回目标与来源页一致：chat 进来回 chat，其余回 title。
  const patchEndpoint = (sec: EndpointSection, key: string, v: string): void => {
    if (sec === "tts") {
      request.current?.abort();
      request.current = null;
      invalidateWarmup();
      voiceEdited.current = true;
    }
    if (sec === "llm" && firstSetup) {
      setDraft(previous => ({...previous, [key]: v, vision: false, ...(key === "url" && !supportsThinking(v) ? {thinking: false} : {})}));
      return;
    }
    const field = sec === "tts" && indexTts
      ? key === "url" ? "indexUrl" : key === "key" ? "indexKey" : key
      : key;
    if (sec === "tts" && key === "engine") setShowKey(false);
    update({
      settings: { ...settings, [sec]: { ...settings[sec], [field]: v, ...(sec === "llm" ? {vision:false} : {}), ...(sec === "llm" && key === "url" && !supportsThinking(v) ? { thinking: false } : {}) } },
    });
  };

  const keyRow = (sec: EndpointSection, disabled = false) => (
    <FieldRow label={t("settings.apiKey")}>
      <input
        type={showKey ? "text" : "password"}
        value={endpoint[sec].key}
        disabled={disabled || (firstSetup && running)}
        onChange={(e) => patchEndpoint(sec, "key", e.target.value)}
      />
      <IconButton icon={showKey ? "eyeOff" : "eye"}
        label={t(showKey ? "settings.hideKey" : "settings.showKey")}
        tip={t(showKey ? "settings.hideKey" : "settings.showKey")}
        disabled={disabled} onClick={() => setShowKey(value => !value)}/>
    </FieldRow>
  );
  return (
<>
{section === "llm" && <section data-intro="llm" className="panel settings-col opt-list">
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
      disabled={firstSetup && running}
      value={settings.llm.model}
      placeholder={t("settings.llmModelPh")}
      onChange={(e) => patchEndpoint("llm", "model", e.target.value)}
    />
  </FieldRow>
  <div inert={!!intro.data && intro.data.phase!=="completed"}><FieldRow label={t("settings.thinking")} hint={t("settings.thinkingHint")}>
    <Switch
      on={settings.llm.thinking && supportsThinking(settings.llm.url)}
      disabled={!supportsThinking(settings.llm.url)}
      title={t("settings.thinking")}
      onChange={(thinking) => update({
        settings: { ...settings, llm: { ...settings.llm, thinking } },
      })}
    />
  </FieldRow>
</div>
</section>}
{section === "tts" && <section onBlur={() => {
  if (voiceEdited.current) {
    voiceEdited.current = false;
    if (desktop() || meetingIdentity()) warmVoice();
  }
}} data-intro="tts" className="panel settings-col opt-list">
  <h3 className="opt-group">
    {t("settings.groups.tts")}
    <Hint text={t(indexTts ? "settings.indexTtsHint" : "settings.ttsHint")} side="down" />
  </h3>
  <FieldRow label={t("settings.ttsEngine")}>
    <Select label={t("settings.ttsEngine")} value={indexTts ? "index-tts" : "gpt-sovits"}
      options={[{value:"gpt-sovits",label:"GPT-SoVITS"},{value:"index-tts",label:"IndexTTS"}]}
      onChange={value=>patchEndpoint("tts","engine",value)}/>
  </FieldRow>
  {urlRow("tts", indexTts ? "settings.indexTtsUrlPh" : "settings.ttsUrlPh")}
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
  {!indexTts && <FieldRow label={t("settings.ttsRefText")}>
    <input
      value={settings.tts.prompt}
      placeholder={t("settings.ttsRefTextPh")}
      onChange={(e) => patchEndpoint("tts", "prompt", e.target.value)}
    />
  </FieldRow>}
  {/* 合成语言不单独配置：跟随「通用」页的对话语言
      （见 i18n 的 resolveChatLang 与 services/ttsClient.ts）。 */}
</section>}
</>
  );
}
