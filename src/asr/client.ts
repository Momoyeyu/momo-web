// ASR 客户端：Deepgram 对齐 GET /v1/listen（WebSocket）。
// 上行裸 PCM s16le 16kHz mono 二进制帧；下行 JSON 事件
// （Metadata / SpeechStarted / UtteranceEnd / Results / Error）。
// 浏览器 WS 不能设 Authorization 头 → 用 ?token= query（provider-protocol §1.1）。
// 断句在服务端 VAD；前端只转发 PCM 帧与消费事件。

import type { AsrConfig } from "../lib/types";
import { ServiceError } from "../lib/errors";

export interface AsrEvents {
  /** VAD 检测到说话开始（barge-in 触发点）。 */
  onSpeechStarted?: () => void;
  /** VAD 断句结束（一段话说完）。 */
  onUtteranceEnd?: () => void;
  /** 一段 final 转写文本（is_final/speech_final 恒 true）。 */
  onResult?: (transcript: string) => void;
  onError?: (err: unknown) => void;
  onClose?: (code: number) => void;
}

/** 默认 query 参数（不覆盖用户在 url 里已写的同名参数）。 */
const DEFAULT_QUERY: Record<string, string> = {
  encoding: "linear16",
  sample_rate: "16000",
  channels: "1",
  vad_events: "true",
};

/** 规范关闭码：1000 正常 / 4400 参数非法 / 4401 鉴权失败 / 1011 内部错误。 */
export const ASR_CLOSE_NORMAL = 1000;

/** CloseStream 发出后等服务端回声的超时。 */
const CLOSE_TIMEOUT_MS = 800;

/** 规范化 ASR ws url：补 /v1/listen path、token query、默认参数。纯函数可测。 */
export function asrUrl(cfg: AsrConfig): string {
  const u = new URL(cfg.url);
  // base-URL 语义：补 /v1/listen；已含完整端点路径则原样。
  const p = u.pathname.replace(/\/+$/, "");
  if (p.endsWith("/v1/listen")) {
    u.pathname = p;
  } else if (p.endsWith("/v1")) {
    u.pathname = `${p}/listen`;
  } else {
    u.pathname = `${p}/v1/listen`;
  }
  for (const [k, v] of Object.entries(DEFAULT_QUERY)) {
    if (!u.searchParams.has(k)) u.searchParams.set(k, v);
  }
  if (cfg.key) u.searchParams.set("token", cfg.key);
  return u.toString();
}

/** 下行 JSON 事件的最小结构（其他字段透传忽略）。 */
interface AsrServerMessage {
  type?: string;
  message?: string;
  channel?: { alternatives?: { transcript?: string }[] };
}

export class AsrStream {
  private ws: WebSocket | null = null;
  private _open = false;
  /** close() 已发起（等回声/超时中）；用于幂等。 */
  private closing = false;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  get open(): boolean {
    return this._open;
  }

  /** 建立连接；resolve 于 WS open（首个 Metadata 事件由 onResult 之外正常分发）。 */
  connect(cfg: AsrConfig, events: AsrEvents): Promise<void> {
    if (this.ws) this.close();
    this.closing = false;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(asrUrl(cfg));
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      ws.onopen = () => {
        settled = true;
        this._open = true;
        resolve();
      };
      ws.onmessage = (ev: MessageEvent) => this.onMessage(ev.data, events, ws);
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new ServiceError("asr", "unreachable"));
        } else {
          events.onError?.(new ServiceError("asr", "unreachable"));
        }
      };
      ws.onclose = (ev) => {
        this._open = false;
        this.clearCloseTimer();
        if (this.ws === ws) this.ws = null;
        if (!settled) {
          settled = true;
          reject(new ServiceError("asr", "unreachable", ev.code));
        }
        events.onClose?.(ev.code);
      };
    });
  }

  /** 上行一帧 PCM s16le（任意长度，TCP/WS 保序）。未 open 时静默丢弃。 */
  send(pcm: Uint8Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.closing) return;
    // BufferSource 要求 ArrayBuffer（非 SharedArrayBuffer/视图偏移）——
    // 独占 buffer 直接发，否则切出精确副本。
    const buf =
      pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength
        ? pcm.buffer
        : pcm.slice().buffer;
    ws.send(buf as ArrayBuffer);
  }

  /** {type:"Finalize"}：强制断句冲刷 VAD 残留。 */
  finalize(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.closing) return;
    ws.send(JSON.stringify({ type: "Finalize" }));
  }

  /** {type:"CloseStream"} → 等服务端回声或超时后 close(1000)。幂等。 */
  close(): void {
    const ws = this.ws;
    if (!ws || this.closing) return;
    this.closing = true;
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "CloseStream" }));
        // 服务端回声 CloseStream 在 onMessage 里提前关；超时兜底。
        this.closeTimer = setTimeout(() => this.finishClose(ws), CLOSE_TIMEOUT_MS);
      } else {
        // CONNECTING / CLOSING / CLOSED：直接关（CLOSED 时 ws.close 为空操作）。
        ws.close(ASR_CLOSE_NORMAL);
      }
    } catch {
      try {
        ws.close();
      } catch {
        // 忽略二次关闭异常
      }
    }
  }

  /** 回声 CloseStream 或超时到达：真正关 ws。 */
  private finishClose(ws: WebSocket): void {
    this.clearCloseTimer();
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(ASR_CLOSE_NORMAL);
      }
    } catch {
      // 已关闭
    }
  }

  private clearCloseTimer(): void {
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  private onMessage(data: unknown, events: AsrEvents, ws: WebSocket): void {
    if (typeof data !== "string") return; // 下行二进制帧不在协议内，忽略
    let msg: AsrServerMessage;
    try {
      msg = JSON.parse(data) as AsrServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "Metadata":
        // 首个事件，无业务含义
        break;
      case "SpeechStarted":
        events.onSpeechStarted?.();
        break;
      case "UtteranceEnd":
        events.onUtteranceEnd?.();
        break;
      case "Results": {
        const transcript = msg.channel?.alternatives?.[0]?.transcript;
        if (typeof transcript === "string" && transcript.length > 0) {
          events.onResult?.(transcript);
        }
        break;
      }
      case "Error":
        events.onError?.(new Error(msg.message ?? "asr error"));
        break;
      case "CloseStream":
        // 服务端回声：我方 close 流程的应答 → 立即关 ws。
        if (this.closing) this.finishClose(ws);
        break;
      default:
        break;
    }
  }
}
