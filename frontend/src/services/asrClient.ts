import { runtime, desktop, type Runtime } from "./runtime";
// 内置 SenseVoice WebSocket client; recognition and VAD run in the application backend.
import { ServiceError } from "../lib/errors";

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
    if (desktop()) return runtime().then(rt => this.connectRuntime(rt));
    return this.connectRuntime({baseUrl: ""});
  }

  private connectRuntime(rt: Runtime): Promise<void> {
    this.closing = false;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(rt.baseUrl ? `${rt.baseUrl.replace(/^http/, "ws")}/api/asr/stream` : this.url);
      if (rt.token) ws.onopen = () => ws.send(JSON.stringify({type: "authenticate", token: rt.token}));
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data !== "string") return;
        const msg = parseBuiltinEvent(ev.data);
        if (!msg) return;
        if (this.closing && msg.type !== "finalized") return;
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

/** Only the application's built-in recognizer is used. */
export function createAsr(events: AsrEvents): AsrEngine {
  return new BuiltinAsr(events);
}
