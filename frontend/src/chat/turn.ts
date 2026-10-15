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
import type { ChatMessage, ChatStatus, Settings } from "../lib/types";
import { DirectiveParser } from "../llm/directives";
import type { DirectiveEvent } from "../llm/directives";
import { streamSpeech } from "../services/ttsClient";
import { chat } from "../services/chatClient";
import { SentenceSplitter } from "./sentences";
import { dueDirs } from "./dirs";
import type { PendingDir } from "./dirs";
import { charsPerSec, dwellMs, sentencePauseMs } from "./pacing";

interface ChatEngineEvents {
  onStatus(s: ChatStatus): void;
  /** 一条完整 user 消息落账（打字发送或 ASR final 转写）。 */
  onUserMessage(m: ChatMessage): void;
  /** assistant 回复开始。 */
  onAssistantStart(id: string): void;
  /** 当前句上屏文本（整串替换语义；仅变化时推）。 */
  onDisplay(text: string): void;
  onAssistantDone(m: ChatMessage): void;
  onError(e: Error): void;
}

type Phase = "idle" | "thinking" | "speaking";

/** 一句的 TTS 合成项：合成可并发，块先攒本地，轮到该句展示时才供 player。 */
interface TtsItem {
  chunks: Uint8Array[];
  pushed: number;
  /** streamSpeech 流结束（成败都算——失败句直接跳过不占位）。 */
  done: boolean;
}

/** 展示队列项：一句话 + 它的 TTS（无语音/静音时 tts=null，走驻留计时）
 *  + 句内待触发指令（展示游标越过其偏移才派发）。 */
interface SentItem {
  text: string;
  tts: TtsItem | null;
  /** 本句附着的表情/动作指令，按到达顺序。 */
  dirs: PendingDir[];
  /** 已触发游标：dirs[0..dirIdx) 已派发。 */
  dirIdx: number;
}

/** 逐字播放状态机：句为最小播放单元。 */
interface DisplayState {
  /** 当前展示句下标；== sentences.length 时展示「生产中的尾部」。 */
  idx: number;
  /** 当前句已上屏字符数（浮点累加，取整渲染）。 */
  reveal: number;
  /** 当前句上屏完成时刻（无 TTS 驻留计时起点；未完成为 0）。 */
  doneAt: number;
  /** 句间停顿截止时刻（上次切句后）。 */
  pausedUntil: number;
  /** 最近一次推给 UI 的字幕（去重避免无效渲染）。 */
  emitted: string;
}

interface Turn {
  id: string;
  abort: AbortController;
  /** 只杀 TTS 合成不杀 LLM：静音时 abort 在途 speech 请求并跳过新句子。 */
  audioAbort: AbortController;
  userText: string;
  /** assistant 已产出全文（打断按此落账）。 */
  text: string;
  llmDone: boolean;
  finished: boolean;
  /** 是否真有音频推给 player（决定收尾要不要等 drain）。 */
  pushedAudio: boolean;
  /** TTS 不可用/失败每回合只上报一次 onError。 */
  ttsErrorReported: boolean;
  sentences: SentItem[];
  /** TTS 供块游标：只允许供到当前展示句。 */
  pushIndex: number;
  inflight: number;
  disp: DisplayState;
  /** splitter.pending 快照：生产中未断句的尾部（逐字上屏的另一半）。 */
  tail: string;
  /** 解析到但未成句的指令：offset = 到达时 pending 长度；成句时挂到该句。 */
  pendingDirs: PendingDir[];
  /** 播放 tick（setInterval id）。 */
  timer: number;
}

const INTERRUPT_DEBOUNCE_MS = 300;
const DISPLAY_TICK_MS = 40;

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
  /** 最近一次上屏字幕（Chat 页中途挂载时同步用）。 */
  private lastDisplay = "";

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

  /** 当前应显示的字幕（当前句上屏文本；无回合时为最近一次）。 */
  get display(): string {
    return this.lastDisplay;
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
    return streamSpeech(cfg.tts, m.text, {
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
      llmDone: false,
      finished: false,
      pushedAudio: false,
      ttsErrorReported: false,
      sentences: [],
      pushIndex: 0,
      inflight: 0,
      disp: { idx: 0, reveal: 0, doneAt: 0, pausedUntil: 0, emitted: "" },
      tail: "",
      pendingDirs: [],
      timer: 0,
    };
    this.turn = turn;
    this.lastDisplay = "";
    turn.timer = window.setInterval(() => this.displayTick(turn), DISPLAY_TICK_MS);
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
    window.clearInterval(turn.timer);
    turn.inflight = 0;
    this.safe(() => this.player.stop());
    this.turn = null;
    if (turn.text.trim()) {
      const msg: ChatMessage = {
        id: turn.id,
        role: "assistant",
        text: turn.text,
        at: new Date().toISOString(),
      };
      this.history.push(msg);
      this.events.onAssistantDone(msg);
    }
    // 表情是回合内状态：回合中止/结束统一复位。
    this.tryStage((st) => st.resetExpression());
    this.setPhase("idle");
  }

  private async runTurn(turn: Turn, cfg: Settings, userText: string): Promise<void> {
    const parser = new DirectiveParser();
    const splitter = new SentenceSplitter();

    // 指令后的首个文本片常带前导空格/换行，剥掉避免字幕顶格留白。
    let afterTag = false;
    const feedEvents = (events: DirectiveEvent[]): void => {
      for (const e of events) {
        if (this.turn !== turn) return;
        if (e.kind === "text") {
          const delta = afterTag ? e.text.replace(/^\s+/, "") : e.text;
          afterTag = false;
          if (!delta) continue;
          turn.text += delta;
          for (const s of splitter.push(delta)) this.pushSentence(turn, cfg, s);
          turn.tail = splitter.pending;
        } else if (e.kind === "exp") {
          afterTag = true;
          // 不立即驱动舞台：记录其在未断句尾部的偏移，展示游标越过才触发。
          turn.pendingDirs.push({
            kind: "exp",
            name: e.name,
            offset: splitter.pending.length,
          });
        } else {
          afterTag = true;
          turn.pendingDirs.push({
            kind: "motion",
            name: e.id,
            offset: splitter.pending.length,
          });
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
    if (tail && tail.trim()) this.pushSentence(turn, cfg, tail);
    turn.tail = "";
    // 末句之后的尾随指令：挂到队列末句（offset=句长，句末触发）；队列空则立即派发。
    if (turn.pendingDirs.length) {
      const last = turn.sentences[turn.sentences.length - 1];
      if (last) {
        for (const d of turn.pendingDirs) {
          last.dirs.push({ ...d, offset: last.text.length });
        }
      } else {
        for (const d of turn.pendingDirs) this.fireDir(d);
      }
      turn.pendingDirs = [];
    }
    turn.llmDone = true;
    this.maybeFinish(turn);
  }

  /** 一句成句 → 入展示队列（tts=null 时走驻留），并立刻发 streamSpeech 并发合成。 */
  private pushSentence(turn: Turn, cfg: Settings, sentence: string): void {
    if (turn.finished) return;
    // 成句时收走累积的待触发指令：offset 即其在本句内的字符位置。
    const item: SentItem = {
      text: sentence,
      tts: null,
      dirs: turn.pendingDirs,
      dirIdx: 0,
    };
    turn.pendingDirs = [];
    turn.sentences.push(item);
    if (this.voiceMuted || turn.audioAbort.signal.aborted) return;
    if (!cfg.tts.url) {
      this.reportTtsOnce(turn, new ServiceError("tts", "unconfigured"));
      return;
    }
    const tts: TtsItem = { chunks: [], pushed: 0, done: false };
    item.tts = tts;
    turn.inflight += 1;

    const settle = (err?: unknown): void => {
      tts.done = true;
      turn.inflight -= 1;
      if (err !== undefined) this.reportTtsOnce(turn, toError(err));
      this.flushTts(turn);
      this.maybeFinish(turn);
    };

    // 任一条件触发即取消：回合被打断（abort）或语音被关掉（audioAbort）。
    const signal = AbortSignal.any([turn.abort.signal, turn.audioAbort.signal]);

    let req: Promise<void>;
    try {
      req = streamSpeech(cfg.tts, sentence, {
        signal,
        onChunk: (pcm) => {
          tts.chunks.push(pcm);
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
   * 按句供块：只有当前展示句（disp.idx）及其之前的句子允许向 player 供块；
   * 未轮到的句先在本地攒着——这样每句音频正好在该句展示时开声，句间停顿天然生效。
   */
  private flushTts(turn: Turn): void {
    if (this.turn !== turn || turn.finished) return;
    const ss = turn.sentences;
    while (turn.pushIndex < ss.length && turn.pushIndex <= turn.disp.idx) {
      const item = ss[turn.pushIndex].tts;
      if (!item) {
        turn.pushIndex += 1;
        continue;
      }
      while (item.pushed < item.chunks.length) {
        const pcm = item.chunks[item.pushed];
        item.pushed += 1;
        this.safe(() => this.player.push(pcm));
        turn.pushedAudio = true;
      }
      if (!item.done) break;
      turn.pushIndex += 1;
    }
  }

  /** 播放 tick：逐字上屏 → 判切句 → 供 TTS 块 → 判收尾。 */
  private displayTick(turn: Turn): void {
    if (this.turn !== turn || turn.finished) return;
    this.flushTts(turn);
    const now = performance.now();
    if (now < turn.disp.pausedUntil) {
      this.maybeFinish(turn);
      return;
    }

    const g = getSettings().general;
    const active = turn.sentences[turn.disp.idx];
    let fullText: string;
    let complete: boolean;
    if (active) {
      fullText = active.text;
      complete = true;
    } else {
      // 生产中的未断句尾部：跟着产出速度走（速率 = min(文字速度, 产出)）。
      const tail = turn.tail.trimStart();
      if (!tail) {
        this.maybeFinish(turn);
        return;
      }
      fullText = tail;
      complete = false;
    }

    // 逐字上屏：受文字速度封顶，不超过已产出长度。
    const target = fullText.length;
    if (turn.disp.reveal < target) {
      const rate = charsPerSec(g.textSpeed);
      turn.disp.reveal =
        rate === Infinity
          ? target
          : Math.min(target, turn.disp.reveal + rate * (DISPLAY_TICK_MS / 1000));
      if (turn.disp.reveal >= target) turn.disp.doneAt = now;
    }
    const shown = fullText.slice(0, Math.floor(turn.disp.reveal));
    if (shown !== turn.disp.emitted) {
      turn.disp.emitted = shown;
      this.lastDisplay = shown;
      this.events.onDisplay(shown);
      if (shown && this.phase === "thinking") this.setPhase("speaking");
    }
    if (!complete) return;

    // 展示游标越过指令位置才派发（offset 越界收敛到句尾；句中途可切换）。
    const due = dueDirs(active.dirs, active.dirIdx, turn.disp.reveal, target);
    while (active.dirIdx < due) {
      this.fireDir(active.dirs[active.dirIdx]);
      active.dirIdx += 1;
    }

    // 完整句的播完判定：TTS 开 = 音频播完；TTS 关/本句无音频 = 上屏完 + 按句长驻留。
    const tts = active.tts;
    const hasAudio = !!tts && !(tts.done && tts.chunks.length === 0);
    let ended = false;
    if (hasAudio && tts) {
      const audioDone =
        tts.done && turn.pushIndex > turn.disp.idx && !this.playerPlaying();
      if (audioDone) {
        // 音频播完即本句播完：未上完的字一次补齐再切句。
        if (turn.disp.reveal < target) {
          turn.disp.reveal = target;
          turn.disp.emitted = fullText;
          this.lastDisplay = fullText;
          this.events.onDisplay(fullText);
        }
        ended = true;
      }
    } else if (
      turn.disp.doneAt > 0 &&
      now - turn.disp.doneAt >= dwellMs(g.sentenceSpeed, target)
    ) {
      ended = true;
    }
    if (ended) {
      // 兜底：句结束时仍未触发的指令全部派发。
      while (active.dirIdx < active.dirs.length) {
        this.fireDir(active.dirs[active.dirIdx]);
        active.dirIdx += 1;
      }
      turn.disp.pausedUntil = now + sentencePauseMs(g.sentenceSpeed);
      turn.disp.idx += 1;
      turn.disp.reveal = 0;
      turn.disp.doneAt = 0;
    }
    this.flushTts(turn);
    this.maybeFinish(turn);
  }

  /** 收尾判定：LLM 流完 + TTS 请求全部完成 + 展示队列播完 + （若有音频）player 播空。 */
  private maybeFinish(turn: Turn): void {
    if (this.turn !== turn || turn.finished) return;
    if (!turn.llmDone || turn.inflight > 0) return;
    if (turn.disp.idx < turn.sentences.length) return; // 还有句没播完
    if (turn.tail.trim()) return; // 尾部未落句（llmDone 后应已 flush，保险）
    if (turn.pushedAudio && this.playerPlaying()) return;
    this.completeTurn(turn);
  }

  private completeTurn(turn: Turn): void {
    turn.finished = true;
    window.clearInterval(turn.timer);
    this.turn = null;
    if (turn.text.trim()) {
      const msg: ChatMessage = {
        id: turn.id,
        role: "assistant",
        text: turn.text,
        at: new Date().toISOString(),
      };
      this.history.push(msg);
      this.events.onAssistantDone(msg);
    }
    // 表情持续到本次回复结束：回合完成复位。
    this.tryStage((st) => st.resetExpression());
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

  /** 派发一条表情/动作指令到舞台（未就绪由 tryStage 静默降级）。 */
  private fireDir(d: PendingDir): void {
    if (d.kind === "exp") this.tryStage((st) => st.setExpression(d.name));
    else this.tryStage((st) => st.playMotion(d.name));
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
