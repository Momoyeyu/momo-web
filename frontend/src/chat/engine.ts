// ChatEngine 应用级单例：与 Live2DStage 同生命周期。
// Chat 页挂载时 attach 自己的事件回调，卸载时 detach；
// 引擎本体跨页面存活——离开 chat 页（如打开 backlog）回合仍在推进，
// 已落账历史随时可通过 engine.history 读取。
// transcript 版本号：任何消息事件 +1，供 React 外部存储订阅（backlog 页用）。

import type { ChatMessage, ChatStatus, SessionMessage } from "../lib/types";
import { ChatEngine } from "./turn";

export interface EngineHandlers {
  onStatus?: (s: ChatStatus) => void;
  onUserMessage?: (m: ChatMessage) => void;
  onAssistantStart?: (id: string) => void;
  /** 当前句上屏文本（整串替换语义）。 */
  onDisplay?: (text: string) => void;
  onAssistantDone?: (m: ChatMessage) => void;
  onError?: (e: Error) => void;
}

let handlers: EngineHandlers = {};
let version = 0;
const listeners = new Set<() => void>();

const bump = (): void => {
  version++;
  for (const l of listeners) l();
};

export function subscribeTranscript(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function transcriptVersion(): number {
  return version;
}

/** Chat 页挂载：接管引擎事件。重复 attach 直接覆盖。 */
export function attachEngine(h: EngineHandlers): void {
  handlers = h;
}

export function detachEngine(h: EngineHandlers): void {
  if (handlers === h) handlers = {};
}

/** 读档：存档 messages 灌进引擎内存转写，并通知 transcript 订阅者刷新。 */
export function loadTranscript(messages: SessionMessage[]): void {
  getChatEngine().loadHistory(messages);
  bump();
}

let engine: ChatEngine | null = null;

export function getChatEngine(): ChatEngine {
  if (!engine) {
    engine = new ChatEngine({
      onStatus: (s) => {
        handlers.onStatus?.(s);
        bump();
      },
      onUserMessage: (m) => {
        handlers.onUserMessage?.(m);
        bump();
      },
      onAssistantStart: (id) => {
        handlers.onAssistantStart?.(id);
        bump();
      },
      onDisplay: (text) => {
        handlers.onDisplay?.(text);
        bump();
      },
      onAssistantDone: (m) => {
        handlers.onAssistantDone?.(m);
        bump();
      },
      onError: (e) => handlers.onError?.(e),
    });
  }
  return engine;
}
