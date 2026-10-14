// 回合协调器：文字/语音输入 → backend SSE（/api/chat，ReAct 在 backend）
// → 情绪解析 + 句切 → TTS 流式播放 → 口型/表情驱动；
// 打断（SpeechStarted / stop）= 停播放 + abort SSE/TTS。
// 设置每次回合开始从 store 现读——setting 页改动无需重启即生效。

import { AsrStream } from "../services/asrClient";
import { MicStreamer } from "../audio/capture";
import { TtsPlayer } from "../audio/player";
import { getStage } from "../live2d/stage";
import type { Live2DStage } from "../live2d/stage";
import { ServiceError } from "../lib/errors";
import { getSettings, newId, subscribe } from "../lib/store";
import type {
  ChatMessage,
  ChatStatus,
  EmotionTag,
  Settings,
} from "../lib/types";
import { EmotionParser } from "../llm/emotion";
import type { EmotionEvent } from "../llm/emotion";
import { streamSpeech } from "../services/ttsClient";
import { chat } from "../services/chatClient";
import { SentenceSplitter } from "./sentences";

interface ChatEngineEvents {
  onStatus(s: ChatStatus): void;
  /** 一条完整 user 消息落账（打字发送或 ASR final 转写）。 */
  onUserMessage(m: ChatMessage): void;
  /** assistant 回复开始（id 供 delta 累积）。 */
  onAssistantStart(id: string): void;
  onAssistantDelta(id: string, textDelta: string): void;
  onAssistantDone(m: ChatMessage): void;
  onError(e: Error): void;
}

type Phase = "idle" | "thinking" | "speaking";

/** 一句的 TTS 队列项：合成可并发，块先攒本地，按句序统一补推/直通给 player。 */
interface TtsItem {
  chunks: Uint8Array[];
  pushed: number;
  /** streamSpeech 流结束（成败都算——失败句直接跳过不占位）。 */
  done: boolean;
}

interface Turn {
  id: string;
  abort: AbortController;
  /** 只杀 TTS 合成不杀 LLM：静音时 abort 在途 speech 请求并跳过新句子。 */
  audioAbort: AbortController;
  userText: string;
  /** assistant 已产出全文（打断按此落账）。 */
  text: string;
  /** 本消息最近一个情绪 tag（消息 emotion + TTS emotion 参数）。 */
  emotion: EmotionTag | undefined;
  llmDone: boolean;
  finished: boolean;
  /** 是否真有音频推给 player（决定收尾要不要等 drain）。 */
  pushedAudio: boolean;
  /** TTS 不可用/失败每回合只上报一次 onError。 */
  ttsErrorReported: boolean;
  queue: TtsItem[];
  /** 队头推进游标：queue[pushIndex] 是允许直通的当前句。 */
  pushIndex: number;
  inflight: number;
}

const INTERRUPT_DEBOUNCE_MS = 300;

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

export class ChatEngine {
  private readonly events: ChatEngineEvents;
  private readonly player = new TtsPlayer();

  private phase: Phase = "idle";
  private reported: ChatStatus = "idle";
  private turn: Turn | null = null;

  private mic: MicStreamer | null = null;
  private asr: AsrStream | null = null;
  private micOn = false;
  private micStarting = false;

  private lastInterruptAt = 0;
  private disposed = false;
  private voiceMuted = false;
  private unsubVolume: (() => void) | null = null;

  constructor(ev: ChatEngineEvents) {
    this.events = ev;
    this.applyVolume();
    this.unsubVolume = subscribe(() => this.applyVolume());
    this.player.onMouthOpen = (v) =>
      this.tryStage((s) => s.setMouthOpen(v));
    this.player.onDrain = () => {
      const t = this.turn;
      if (t) this.maybeFinish(t);
    };
  }

  /** 对外上报的单维状态：回合中 thinking/speaking 优先于 listening。 */
  get status(): ChatStatus {
    if (this.phase !== "idle") return this.phase;
    return this.micOn ? "listening" : "idle";
  }

  /** 麦克风是否开着（持续监听形态，与回合状态正交）。 */
  get listening(): boolean {
    return this.micOn;
  }

  /** 语音输出静音开关（工具栏即时切换，不持久化）。 */
  get muted(): boolean {
    return this.voiceMuted;
  }

  setMuted(m: boolean): void {
    if (this.voiceMuted === m) return;
    this.voiceMuted = m;
    this.applyVolume();
    if (m) {
      this.turn?.audioAbort.abort();
      this.safe(() => this.player.stop());
    } else if (this.turn && this.turn.audioAbort.signal.aborted) {
      this.turn.audioAbort = new AbortController();
    }
  }

  /**
   * backlog 语音重播：空闲时把一条 assistant 消息重新合成播放
   * （口型随播放驱动，不进历史、不占回合）。回合进行中调用为空操作。
   */
  replayMessage(m: ChatMessage): Promise<void> {
    if (
      this.disposed ||
      this.phase !== "idle" ||
      m.role !== "assistant" ||
      !m.text.trim()
    ) {
      return Promise.resolve();
    }
    const cfg = getSettings();
    if (!cfg.tts.url) return Promise.resolve();
    this.safe(() => this.player.stop());
    return streamSpeech(cfg.tts, m.text, m.emotion, {
      onChunk: (pcm) => {
        if (this.disposed) return;
        this.safe(() => this.player.push(pcm));
      },
    });
  }

  /** 已落账对话历史（system prompt 组装用）。 */
  readonly history: ChatMessage[] = [];

  /** 发送一条用户文本并跑一回合（thinking→speaking→idle）。 */
  sendText(text: string): void {
    if (this.disposed) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    // 新输入隐式打断在途回合（绕过防抖，保证打断一定生效）。
    if (this.phase !== "idle") this.interruptNow();

    const cfg = getSettings();
    if (!cfg.llm.url) {
      this.events.onError(new ServiceError("llm", "unconfigured"));
      return;
    }

    // 停掉可能在播的 backlog 重播音频，避免叠在新回合的 TTS 上。
    this.safe(() => this.player.stop());

    const userMsg: ChatMessage = {
      id: newId("m"),
      role: "user",
      text: trimmed,
      at: new Date().toISOString(),
    };
    this.history.push(userMsg);
    this.events.onUserMessage(userMsg);

    const turn: Turn = {
      id: newId("m"),
      abort: new AbortController(),
      audioAbort: new AbortController(),
      userText: trimmed,
      text: "",
      emotion: undefined,
      llmDone: false,
      finished: false,
      pushedAudio: false,
      ttsErrorReported: false,
      queue: [],
      pushIndex: 0,
      inflight: 0,
    };
    this.turn = turn;
    this.events.onAssistantStart(turn.id);
    this.setPhase("thinking");
    void this.runTurn(turn, cfg, trimmed);
  }

  /** 开启麦克风 → ASR 流；SpeechStarted 在 speaking 时触发 barge-in。幂等。 */
  async startListening(): Promise<void> {
    if (this.disposed || this.micOn || this.micStarting) return;
    const cfg = getSettings();
    if (!cfg.asr.url) {
      this.events.onError(new ServiceError("asr", "unconfigured"));
      return;
    }
    this.micStarting = true;
    const mic = new MicStreamer();
    const asr = new AsrStream();
    try {
      await asr.connect(cfg.asr, {
        onSpeechStarted: () => {
          if (this.phase !== "idle") this.interrupt();
        },
        onResult: (t) => {
          if (t.trim()) this.sendText(t);
        },
        onError: (e) => this.events.onError(toError(e)),
        onClose: (_code) => {
          // 服务端断连：若我们认为还在听，收尾回到非监听态。
          if (this.asr === asr) {
            this.asr = null;
            this.micOn = false;
            this.safe(() => this.mic?.cancel());
            this.mic = null;
            this.emitStatus();
          }
        },
      });
      // WS 就绪后再开采集，避免开头几帧静默丢弃。
      await mic.start((pcm) => asr.send(pcm), {
        onError: (e) => this.events.onError(toError(e)),
      });
      this.mic = mic;
      this.asr = asr;
      this.micOn = true;
      this.emitStatus();
    } catch (e) {
      this.safe(() => mic.cancel());
      this.safe(() => asr.close());
      this.events.onError(toError(e));
    } finally {
      this.micStarting = false;
    }
  }

  /** 关麦（释放 ASR 连接与采集）。 */
  stopListening(): void {
    this.micOn = false;
    const mic = this.mic;
    const asr = this.asr;
    this.mic = null;
    this.asr = null;
    if (mic) this.safe(() => mic.cancel());
    if (asr) this.safe(() => asr.close());
    this.emitStatus();
  }

  /** 打断：停播放、abort 在途 LLM/TTS、当前 assistant 消息按已产出部分落账。
   *  300ms 防抖——重复触发（SpeechStarted + 手动停止）忽略。 */
  interrupt(): void {
    if (!this.turn) {
      this.safe(() => this.player.stop());
      return;
    }
    const now = Date.now();
    if (now - this.lastInterruptAt < INTERRUPT_DEBOUNCE_MS) return;
    this.lastInterruptAt = now;
    this.interruptNow();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubVolume?.();
    this.interruptNow();
    this.stopListening();
    this.safe(() => this.player.dispose());
  }

  // ---------- 内部 ----------

  private interruptNow(): void {
    const turn = this.turn;
    if (!turn) {
      this.safe(() => this.player.stop());
      return;
    }
    turn.finished = true;
    turn.abort.abort();
    turn.queue.length = 0;
    turn.pushIndex = 0;
    turn.inflight = 0;
    this.safe(() => this.player.stop());
    this.turn = null;
    if (turn.text.trim()) {
      const msg: ChatMessage = {
        id: turn.id,
        role: "assistant",
        text: turn.text,
        emotion: turn.emotion,
        at: new Date().toISOString(),
      };
      this.history.push(msg);
      this.events.onAssistantDone(msg);
    }
    this.setPhase("idle");
  }

  private async runTurn(turn: Turn, cfg: Settings, userText: string): Promise<void> {
    const parser = new EmotionParser();
    const splitter = new SentenceSplitter();

    // tag 标记后的首个文本片常带前导空格/换行，剥掉避免字幕顶格留白。
    let afterTag = false;
    const feedEvents = (events: EmotionEvent[]): void => {
      for (const e of events) {
        if (this.turn !== turn) return;
        if (e.kind === "text") {
          const delta = afterTag ? e.text.replace(/^\s+/, "") : e.text;
          afterTag = false;
          if (!delta) continue;
          turn.text += delta;
          this.events.onAssistantDelta(turn.id, delta);
          for (const s of splitter.push(delta)) this.enqueueTts(turn, cfg, s);
        } else {
          turn.emotion = e.tag;
          afterTag = true;
          this.tryStage((st) => st.playEmotion(e.tag));
        }
      }
    };

    // LLM 调用在 backend（system prompt/历史/记忆工具由它组装），
    // 前端只发本回合文本、收 SSE delta。
    try {
      for await (const ev of chat(userText, turn.abort.signal)) {
        if (this.turn !== turn) return; // 已被打断
        if (ev.t === "delta") {
          feedEvents(parser.push(ev.text));
        } else if (ev.t === "error") {
          throw new ServiceError("llm", "http", 0, ev.message);
        }
        // done：流结束，走统一收尾
      }
    } catch (err) {
      if (this.turn === turn) this.events.onError(toError(err));
    }
    if (this.turn !== turn) return; // 已被打断，部分文本由 interruptNow 落账

    feedEvents(parser.flush());
    const tail = splitter.flush();
    if (tail && tail.trim()) this.enqueueTts(turn, cfg, tail);
    turn.llmDone = true;
    this.maybeFinish(turn);
  }

  /** 一句成句 → 立刻发 streamSpeech（并发合成），块入队列等序播放。 */
  private enqueueTts(turn: Turn, cfg: Settings, sentence: string): void {
    if (turn.finished) return;
    if (this.voiceMuted || turn.audioAbort.signal.aborted) return;
    if (!cfg.tts.url) {
      this.reportTtsOnce(turn, new ServiceError("tts", "unconfigured"));
      return;
    }
    const item: TtsItem = { chunks: [], pushed: 0, done: false };
    turn.queue.push(item);
    turn.inflight += 1;

    const settle = (err?: unknown): void => {
      item.done = true;
      turn.inflight -= 1;
      if (err !== undefined) this.reportTtsOnce(turn, toError(err));
      this.flushTts(turn);
      this.maybeFinish(turn);
    };

    // 任一条件触发即取消：回合被打断（abort）或语音被关掉（audioAbort）。
    const signal = AbortSignal.any([turn.abort.signal, turn.audioAbort.signal]);

    let req: Promise<void>;
    try {
      req = streamSpeech(cfg.tts, sentence, turn.emotion, {
        signal,
        onChunk: (pcm) => {
          item.chunks.push(pcm);
          this.flushTts(turn);
        },
      });
    } catch (err) {
      settle(err);
      return;
    }
    req.then(() => settle(), (err: unknown) => settle(err));
  }

  private reportTtsOnce(turn: Turn, err: Error): void {
    if (this.turn !== turn || turn.ttsErrorReported) return;
    turn.ttsErrorReported = true;
    this.events.onError(err);
  }

  /**
   * 保序推送：只有队头句（其前面各句已流完且全部块已推）才能向 player 供块；
   * 队头句未流完时，后到的块直通；未轮到的句先在本地数组攒着。
   */
  private flushTts(turn: Turn): void {
    if (this.turn !== turn || turn.finished) return;
    const queue = turn.queue;
    while (turn.pushIndex < queue.length) {
      const item = queue[turn.pushIndex];
      while (item.pushed < item.chunks.length) {
        const pcm = item.chunks[item.pushed];
        item.pushed += 1;
        this.safe(() => this.player.push(pcm));
        turn.pushedAudio = true;
        if (this.phase === "thinking") this.setPhase("speaking");
      }
      if (!item.done) break;
      turn.pushIndex += 1;
    }
  }

  /** 收尾判定：LLM 流完 + TTS 请求全部完成 + （若有音频）player 播空。 */
  private maybeFinish(turn: Turn): void {
    if (this.turn !== turn || turn.finished) return;
    if (!turn.llmDone || turn.inflight > 0) return;
    if (turn.pushedAudio && this.playerPlaying()) return;
    this.completeTurn(turn);
  }

  private completeTurn(turn: Turn): void {
    turn.finished = true;
    this.turn = null;
    if (turn.text.trim()) {
      const msg: ChatMessage = {
        id: turn.id,
        role: "assistant",
        text: turn.text,
        emotion: turn.emotion,
        at: new Date().toISOString(),
      };
      this.history.push(msg);
      this.events.onAssistantDone(msg);
    }
    this.setPhase("idle");
  }

  private playerPlaying(): boolean {
    try {
      return this.player.playing;
    } catch {
      return false;
    }
  }

  private applyVolume(): void {
    this.player.setVolume(
      this.voiceMuted ? 0 : getSettings().general.voiceVolume / 100,
    );
  }

  private setPhase(p: Phase): void {
    this.phase = p;
    this.emitStatus();
  }

  private emitStatus(): void {
    const s = this.status;
    if (s !== this.reported) {
      this.reported = s;
      this.events.onStatus(s);
    }
  }

  private tryStage(fn: (s: Live2DStage) => void): void {
    try {
      fn(getStage());
    } catch {
      // 舞台未就绪/模型未加载：表情驱动静默降级
    }
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // 依赖未实现/资源已释放时静默
    }
  }
}
