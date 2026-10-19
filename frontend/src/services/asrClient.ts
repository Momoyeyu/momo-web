// ASR 客户端：两种引擎，统一事件。
//
//   builtin —— 内置 SenseVoice（backend `/api/asr/stream`，WS）：
//       上行裸 PCM s16le 16k mono；下行 {type: ready|speech_started|transcript|finalized|error}
//   openai  —— 任何兼容 OpenAI `POST /v1/audio/transcriptions` 的服务：
//       本地 VAD 断句 → 整段上传；不依赖远端 VAD 事件。
//
// 为什么没有 Deepgram：内置引擎落地后它没有不可替代性，协议解析维护成本
// 还要一直背着；自定义 ASR 统一走 OpenAI 事实标准（whisper.cpp / Speaches /
// LocalAI / Groq / OpenAI 都实现同一端点）。
//
// barge-in（说话打断）在两种引擎下都成立：builtin 由服务端 VAD 出
// `speech_started`，openai 由本地能量 VAD 出。

import type { AsrConfig } from "../lib/types";
import { ServiceError } from "../lib/errors";
import { resolveChatLang } from "../i18n";

export interface AsrEvents {
  /** 检测到说话开始（barge-in 触发点）。 */
  onSpeechStarted?: () => void;
  /** 一段话的最终文本。 */
  onTranscript?: (text: string) => void;
  onError?: (err: unknown) => void;
  onClose?: (code: number) => void;
}

export interface AsrEngine {
  connect(): Promise<void>;
  send(pcm: Uint8Array): void;
  close(): void;
}

// ---------------------------------------------------------------- builtin

/** 内置 ASR 的 WS 地址：与页面同源，走 vite 代理（dev）/ backend 直连（Tauri）。 */
export function builtinAsrUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/asr/stream`;
}

export interface BuiltinEvent {
  type: string;
  text?: string;
  message?: string;
}

/** 解析内置端点下行的 JSON；非法/未知给 null（上游协议演进时静默忽略）。 */
export function parseBuiltinEvent(raw: string): BuiltinEvent | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const msg = obj as Record<string, unknown>;
  const type = typeof msg.type === "string" ? msg.type : "";
  if (!type) return null;
  return {
    type,
    text: typeof msg.text === "string" ? msg.text : undefined,
    message: typeof msg.message === "string" ? msg.message : undefined,
  };
}

class BuiltinAsr implements AsrEngine {
  private ws: WebSocket | null = null;
  private closing = false;

  constructor(
    private readonly events: AsrEvents,
    private readonly url = builtinAsrUrl(),
  ) {}

  connect(): Promise<void> {
    this.closing = false;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data !== "string") return;
        const msg = parseBuiltinEvent(ev.data);
        if (!msg) return;
        switch (msg.type) {
          case "ready":
            if (!settled) {
              settled = true;
              resolve();
            }
            break;
          case "speech_started":
            this.events.onSpeechStarted?.();
            break;
          case "transcript":
            if (msg.text) this.events.onTranscript?.(msg.text);
            break;
          case "finalized":
            // finalize 的应答：可以安全关闭
            try {
              ws.close(1000);
            } catch {
              // 已关闭
            }
            break;
          case "error":
            this.events.onError?.(
              new ServiceError("asr", "unreachable", 0, msg.message),
            );
            if (!settled) {
              settled = true;
              reject(new ServiceError("asr", "unreachable", 0, msg.message));
            }
            break;
          default:
            break;
        }
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new ServiceError("asr", "unreachable"));
        }
      };
      ws.onclose = (ev) => {
        this.ws = null;
        if (!settled) {
          settled = true;
          reject(new ServiceError("asr", "unreachable", ev.code));
        } else if (!this.closing) {
          // ready 后被动断开：交给上层收尾
          this.events.onClose?.(ev.code);
        }
      };
    });
  }

  send(pcm: Uint8Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.closing) return;
    const buf =
      pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength
        ? pcm.buffer
        : pcm.slice().buffer;
    ws.send(buf as ArrayBuffer);
  }

  close(): void {
    const ws = this.ws;
    if (!ws || this.closing) return;
    this.closing = true;
    try {
      if (ws.readyState === WebSocket.OPEN) {
        // finalize：让服务端把 VAD 里的尾段吐出来再断开
        ws.send(JSON.stringify({ type: "finalize" }));
        setTimeout(() => {
          try {
            ws.close(1000);
          } catch {
            // 已关闭
          }
        }, 400);
      } else {
        ws.close(1000);
      }
    } catch {
      // 忽略二次关闭
    }
  }
}

// ------------------------------------------------------------ openai-http

const SAMPLE_RATE = 16000;
const FRAME = 320; // 20ms
const SPEECH_RMS = 0.012; // 约 -38 dBFS，安静房间可触发、风扇声不触发
const START_FRAMES = 2; // 连续 40ms 过阈值才算开始
const SILENCE_FRAMES = 30; // 600ms 静音断句
const PRE_ROLL_FRAMES = 15; // 300ms 预录，避免吃掉字头
const MAX_FRAMES = 1000; // 20s 上限，防长段卡死

/** 纯函数型能量 VAD：喂 16k mono 帧，吐"开始说话 / 一句话结束"。 */
export class EnergyVad {
  private speaking = false;
  private hot = 0;
  private silence = 0;
  private preRoll: Int16Array[] = [];
  private frames: Int16Array[] = [];

  /** 返回 null = 无事发生；{start:true} = 开始说话；{utterance} = 一句说完。 */
  push(frame: Int16Array): { start?: true; utterance?: Int16Array } | null {
    const rms = frameRms(frame);
    const loud = rms >= SPEECH_RMS;

    if (!this.speaking) {
      this.preRoll.push(frame);
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
      this.hot = loud ? this.hot + 1 : 0;
      if (this.hot >= START_FRAMES) {
        this.speaking = true;
        this.silence = 0;
        // 触发开始的这一帧也要收进 utterances（之前漏了，会吃掉开头 20ms）
        this.frames = [...this.preRoll, frame];
        this.preRoll = [];
        return { start: true };
      }
      return null;
    }

    this.frames.push(frame);
    this.silence = loud ? 0 : this.silence + 1;
    if (this.silence >= SILENCE_FRAMES || this.frames.length >= MAX_FRAMES) {
      const utterance = trimTail(this.frames, this.silence);
      this.reset();
      return utterance.length ? { utterance } : null;
    }
    return null;
  }

  /** 收尾：把还在说的一段吐出来。 */
  flush(): Int16Array | null {
    if (!this.speaking) return null;
    const frames = this.frames.slice();
    this.reset();
    const utterance = trimTail(frames, 0);
    return utterance.length ? utterance : null;
  }

  private reset(): void {
    this.speaking = false;
    this.hot = 0;
    this.silence = 0;
    this.frames = [];
    this.preRoll = [];
  }
}

function frameRms(frame: Int16Array): number {
  if (!frame.length) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}

/** 去掉尾部静音帧（最多 600ms），并把帧拼成连续 PCM。 */
function trimTail(frames: Int16Array[], silenceFrames: number): Int16Array {
  const keep = Math.max(0, frames.length - Math.min(silenceFrames, 30));
  const used = frames.slice(0, keep);
  const total = used.reduce((n, f) => n + f.length, 0);
  const out = new Int16Array(total);
  let at = 0;
  for (const f of used) {
    out.set(f, at);
    at += f.length;
  }
  return out;
}

/** s16le PCM → WAV Blob（OpenAI 接口按文件上传，需要带 WAV 头）。 */
export function pcm16ToWav(pcm: Int16Array, sampleRate = SAMPLE_RATE): Blob {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const write = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44, pcm.length).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}

/** 自定义端点的转写 URL：base 语义（尾部 /v1 或完整端点都吃）。 */
export function transcriptionUrl(base: string): string {
  const u = new URL(base);
  const p = u.pathname.replace(/\/+$/, "");
  if (p.endsWith("/audio/transcriptions")) return u.toString();
  u.pathname = p.endsWith("/v1") ? `${p}/audio/transcriptions` : `${p}/v1/audio/transcriptions`;
  return u.toString();
}

class OpenAiAsr implements AsrEngine {
  private vad = new EnergyVad();
  private carry = new Int16Array(0);

  constructor(
    private readonly cfg: AsrConfig,
    private readonly events: AsrEvents,
  ) {}

  async connect(): Promise<void> {
    // 无持久连接：只校验配置形状（真正失败会在第一次上传时报）
    if (!this.cfg.url) throw new ServiceError("asr", "unconfigured");
  }

  send(pcm: Uint8Array): void {
    // 字节流可能不是 20ms 对齐：拼到整帧再喂 VAD
    const incoming = new Int16Array(
      pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
    );
    const merged = new Int16Array(this.carry.length + incoming.length);
    merged.set(this.carry);
    merged.set(incoming, this.carry.length);
    let offset = 0;
    while (merged.length - offset >= FRAME) {
      const frame = merged.subarray(offset, offset + FRAME);
      offset += FRAME;
      const out = this.vad.push(frame as Int16Array);
      if (!out) continue;
      if (out.start) this.events.onSpeechStarted?.();
      if (out.utterance) void this.transcribe(out.utterance);
    }
    this.carry = merged.slice(offset);
  }

  close(): void {
    const tail = this.vad.flush();
    if (tail) void this.transcribe(tail);
    this.carry = new Int16Array(0);
  }

  private async transcribe(pcm: Int16Array): Promise<void> {
    const form = new FormData();
    form.append("file", pcm16ToWav(pcm), "utterance.wav");
    form.append("model", this.cfg.model || "whisper-1");
    form.append("language", resolveChatLang(this.cfgGeneral()));
    form.append("response_format", "json");
    try {
      const res = await fetch(transcriptionUrl(this.cfg.url), {
        method: "POST",
        headers: this.cfg.key ? { authorization: `Bearer ${this.cfg.key}` } : undefined,
        body: form,
      });
      if (!res.ok) {
        throw new ServiceError("asr", "http", res.status, `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { text?: unknown };
      const text = typeof data.text === "string" ? data.text.trim() : "";
      if (text) this.events.onTranscript?.(text);
    } catch (e) {
      this.events.onError?.(e);
    } finally {
      // 单句失败不影响后续句子
    }
  }

  /** 语言参数跟随对话语言；openai 引擎不持有 general，用模块级快照。 */
  private cfgGeneral(): Parameters<typeof resolveChatLang>[0] {
    return chatLangSnapshot();
  }
}

// 语言快照：由调用方（chatEngine）在创建引擎时写入，避免把 settings 形状
// 硬编码到这个文件里。
let _chatLang: { lang: string; chatLang: string } = { lang: "zh", chatLang: "auto" };
export function setAsrChatLang(lang: string, chatLang: string): void {
  _chatLang = { lang, chatLang: chatLang as string };
}
function chatLangSnapshot(): Parameters<typeof resolveChatLang>[0] {
  return _chatLang as unknown as Parameters<typeof resolveChatLang>[0];
}

// ---------------------------------------------------------------- factory

export function createAsr(cfg: AsrConfig, events: AsrEvents): AsrEngine {
  return cfg.mode === "builtin"
    ? new BuiltinAsr(events)
    : new OpenAiAsr(cfg, events);
}
