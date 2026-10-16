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
import { getAvatarId, getAvatars, getSettings, newId, subscribe } from "../lib/store";
import type {
  ChatMessage,
  ChatStatus,
  CheckpointMessage,
  Settings,
} from "../lib/types";
import { resolveChatLang } from "../i18n";
import { streamSpeech } from "../services/ttsClient";
import {
  chat,
  interrupt as sendInterrupt,
  type SentenceDir,
} from "../services/chatClient";
import { dueDirs, dirAllowed } from "./directives";
import type { PendingDir } from "./directives";
import { charsPerSec, dwellMs, sentencePauseMs } from "./pacing";

interface ChatEngineEvents {
  onStatus(s: ChatStatus): void;
  /** 一条完整 user 消息落账（打字发送或 ASR final 转写）。 */
  onUserMessage(m: ChatMessage): void;
  /** assistant 回复开始。 */
  onAssistantStart(id: string): void;
  /** 当前句上屏文本（整串替换语义；仅变化时推）。 */
  onDisplay(text: string): void;
  /** 一句话已落账并进入转写（流式期间 backlog 就能看到）。 */
  onSentence(m: ChatMessage): void;
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
  /** 恒定为空。切句已全部在 backend 完成，前端不再持有「未断句尾部」；
   *  保留字段是为了不牵动展示层对「生产中文案」的分支（它读到的就是空串）。 */
  tail: string;
  /** 本轮已 push 进转写的句子条数（打断时按「实际看到」重建尾部用）。 */
  pushed: number;
  /** 播放 tick（setInterval id；构造期占位 0）。 */
  timer: ReturnType<typeof setInterval> | number;
}

const INTERRUPT_DEBOUNCE_MS = 300;
const DISPLAY_TICK_MS = 40;

/** 句事件里的指令 → 展示层用的 PendingDir；清单外的静默丢弃。 */
function filterDirs(
  dirs: SentenceDir[],
  res: Parameters<typeof dirAllowed>[2],
): PendingDir[] {
  return dirs.filter((d) => dirAllowed(d.kind, d.name, res));
}

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
  /** 离开 chat 页的挂起标记；micIntended 记录挂起前用户开着麦（回来恢复）。 */
  private micSuspended = false;
  private micIntended = false;

  private lastInterruptAt = 0;
  /** 发送串行链：打断回传完成前不放行新回合请求（G2——两个 POST 并发无序时，
   *  backend 可能先收新消息再收截断，把新回合落账作废）。 */
  private sendQueue: Promise<void> = Promise.resolve();
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
      // 回放与实时合成同一口径：语言 = 对话语言
      lang: resolveChatLang(cfg.general),
      onChunk: (pcm) => {
        if (this.disposed) return;
        this.safe(() => this.player.push(pcm));
      },
    });
  }

  /** 已落账对话历史（system prompt 组装用）。 */
  readonly history: ChatMessage[] = [];

  /**
   * 读档灌入：用存档 messages 整体替换内存转写（backlog/字幕显示它）。
   * 在途回合先打断（其部分落账随旧转写一起被覆盖）；字幕 = 最后一条
   * assistant 的末句，无则空。调用方负责 bumpTranscript 通知订阅者。
   */
  loadHistory(messages: CheckpointMessage[]): void {
    if (this.turn) this.interruptNow(false);
    this.safe(() => this.player.stop());
    this.history.length = 0;
    for (const m of messages) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      this.history.push({
        id: newId("m"),
        role: m.role,
        text: String(m.text ?? ""),
        at: String(m.at ?? ""),
      });
    }
    const last = [...this.history]
      .reverse()
      .find((m) => m.role === "assistant");
    // 落库已是句级（一句一行），末条即最后一句，无需再切
      this.lastDisplay = last ? last.text : "";
    this.events.onDisplay(this.lastDisplay);
  }

  /** 发送一条用户文本并跑一回合（thinking→speaking→idle）。
   *  走串行队列：在途回合先等打断回传落地，再发新回合请求。 */
  sendText(text: string): void {
    if (this.disposed) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    // catch 保底：单次发送异常不毒化队列（否则后续发送全部静默丢失）。
    this.sendQueue = this.sendQueue.then(
      () => this.doSend(trimmed).catch(() => {}),
    );
  }

  private async doSend(trimmed: string): Promise<void> {
    if (this.disposed) return;
    // 新输入隐式打断在途回合（绕过防抖，保证打断一定生效）；
    // await 回传完成：backend 先修正尾对再收新消息，保证消息不乱序。
    if (this.phase !== "idle") await this.interruptNow(true);
    if (this.disposed) return;

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
      pushed: 0,
      timer: 0,
    };
    this.turn = turn;
    this.lastDisplay = "";
    turn.timer = setInterval(() => this.displayTick(turn), DISPLAY_TICK_MS);
    this.events.onAssistantStart(turn.id);
    this.setPhase("thinking");
    void this.runTurn(turn, cfg, trimmed);
  }

  /** 开启麦克风 → ASR 流；SpeechStarted 在 speaking 时触发 barge-in。幂等。 */
  async startListening(): Promise<void> {
    if (this.disposed || this.micOn || this.micStarting) return;
    this.micIntended = true;
    const cfg = getSettings();
    if (!cfg.general.voiceInput) {
      // 语音输入总开关关着：清掉意向静默返回（按钮侧已置灰，这是兜底门）。
      this.micIntended = false;
      return;
    }
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

  /** 离开 chat 页：停麦停 ASR（记住意向，回来恢复）。幂等。 */
  suspendMic(): void {
    if (this.micSuspended) return;
    this.micSuspended = true;
    // stopListening 会无条件清意向，先记下挂起前是否开着再停。
    const intended = this.micOn || this.micStarting || this.micIntended;
    this.stopListening();
    this.micIntended = intended;
  }

  /** 回到 chat 页：挂起前麦是开着的 → 恢复监听。幂等。
   *  前置校验语音输入开关与 ASR 配置——挂起期间可能在设置页被关掉。 */
  resumeMic(): void {
    if (!this.micSuspended) return;
    this.micSuspended = false;
    const cfg = getSettings();
    if (this.micIntended && cfg.general.voiceInput && cfg.asr.url.trim()) {
      void this.startListening();
    }
  }

  /** 关麦（释放 ASR 连接与采集）。无条件清意向——
   *  挂起态由 suspendMic 自己先存意向再调本函数。 */
  stopListening(): void {
    this.micIntended = false;
    this.micOn = false;
    const mic = this.mic;
    const asr = this.asr;
    this.mic = null;
    this.asr = null;
    if (mic) this.safe(() => mic.cancel());
    if (asr) this.safe(() => asr.close());
    this.emitStatus();
  }

  /** 打断：停播放、abort 在途 LLM/TTS、当前 assistant 消息按已展示部分落账，
   *  并回传 backend 截断持久化（两侧一致）。persist=false 用于读档等
   *  无需回传的场景（live 即将被整体覆盖）。
   *  300ms 防抖——重复触发（SpeechStarted + 手动停止）忽略。
   *  回传 promise 挂进发送队列：紧随其后的 sendText 等它落地再发新回合。 */
  interrupt(): void {
    if (!this.turn) {
      this.safe(() => this.player.stop());
      return;
    }
    const now = Date.now();
    if (now - this.lastInterruptAt < INTERRUPT_DEBOUNCE_MS) return;
    this.lastInterruptAt = now;
    const done = this.interruptNow(true);
    this.sendQueue = this.sendQueue.then(() => done);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubVolume?.();
    this.interruptNow(false);
    this.stopListening();
    this.safe(() => this.player.dispose());
  }

  // ---------- 内部 ----------

  /** 用户实际看到的文本：已播完句全文 + 当前展示位的已显露字符
   *  （当前位是未断句尾部时取 tail 的已显露前缀）。 */
  private seenText(turn: Turn): string {
    const parts = turn.sentences
      .slice(0, Math.min(turn.disp.idx, turn.sentences.length))
      .map((s) => s.text);
    const active = turn.sentences[turn.disp.idx];
    const cur = active ? active.text : turn.tail.trimStart();
    const n = Math.min(cur.length, Math.floor(turn.disp.reveal));
    if (n > 0) parts.push(cur.slice(0, n));
    return parts.join("");
  }

  /**
   * 打断执行体：本地立即停（播放/生成/展示），返回回传完成的 Promise
   * 供调用方排序「打断 → 新回合」。persist=false 时立即 resolve。
   */
  private interruptNow(persist: boolean): Promise<void> {
    const turn = this.turn;
    if (!turn) {
      this.safe(() => this.player.stop());
      return Promise.resolve();
    }
    turn.finished = true;
    turn.abort.abort();
    clearInterval(turn.timer);
    turn.inflight = 0;
    this.safe(() => this.player.stop());
    this.turn = null;
    // 落账以「用户实际看到的文本」为准：backlog / 存档 / 下回合上下文
    // 与回传 backend 的截断值一致（assistant 可空，空则本地也不落账）。
    const seen = this.seenText(turn);
    const done = persist
      ? sendInterrupt(turn.userText, seen)
      : Promise.resolve();
    // 各句已逐句进转写；打断时按「用户实际看到的」重建本轮尾部，
    // 与回传 backend 的 seen 同源（backend 用同一规则裁剪 DB 里的本轮行）。
    if (turn.pushed > 0) {
      this.history.splice(this.history.length - turn.pushed, turn.pushed);
    }
    if (seen) {
      const msg: ChatMessage = {
        id: `${turn.id}-seen`,
        role: "assistant",
        text: seen,
        at: new Date().toISOString(),
      };
      this.history.push(msg);
      this.events.onAssistantDone(msg);
    }
    // 表情是回合内状态：回合中止/结束统一复位。
    this.tryStage((st) => st.resetExpression());
    this.setPhase("idle");
    return done;
  }

  private async runTurn(turn: Turn, cfg: Settings, userText: string): Promise<void> {
    // 清单校验：指令值不在当前形象资源清单中 → 静默丢弃。
    // 回合开始取一次快照，与注入提示词的清单同源；清单缺失时不拦（stage 兜底）。
    const resources = getAvatars().find(
      (a) => a.id === getAvatarId(),
    )?.resources;

    // LLM 调用与切句都在 backend（system prompt/历史/记忆工具/句边界由它负责），
    // 前端只发本回合文本、收逐句事件。句事件自带 dirs（含句内偏移），
    // 因此这里不再需要指令流式解析，也不再持有「未断句尾部」。
    try {
      for await (const ev of chat(userText, turn.abort.signal)) {
        if (this.turn !== turn) return; // 已被打断
        if (ev.t === "sentence") {
          turn.text += ev.text;
          this.pushSentence(turn, cfg, ev.text, filterDirs(ev.dirs, resources));
        } else if (ev.t === "error") {
          throw new ServiceError("llm", "http", 0, ev.message);
        }
      }
    } catch (err) {
      if (this.turn === turn) this.events.onError(toError(err));
    }
    if (this.turn !== turn) return; // 已被打断，已落句子由 interruptNow 对齐
    turn.llmDone = true;
    this.maybeFinish(turn);
  }

  /** 一句成句 → 入展示队列（tts=null 时走驻留），并立刻发 streamSpeech 并发合成。 */
  private pushSentence(
    turn: Turn,
    cfg: Settings,
    sentence: string,
    dirs: PendingDir[],
  ): void {
    if (turn.finished) return;
    const item: SentItem = { text: sentence, tts: null, dirs, dirIdx: 0 };
    turn.sentences.push(item);
    // 句落账即进转写：**流式期间 backlog 就能看到这一句**，不必等回合结束。
    // id 用「回合 id + 句序」，与重载后按行重建的转写形态一致。
    const msg: ChatMessage = {
      id: `${turn.id}-${turn.sentences.length - 1}`,
      role: "assistant",
      text: sentence,
      at: new Date().toISOString(),
    };
    turn.pushed += 1;
    this.history.push(msg);
    this.events.onSentence(msg);
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
        lang: resolveChatLang(cfg.general),
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
    clearInterval(turn.timer);
    this.turn = null;
    // 各句已在 pushSentence 里逐句落账，这里只发「回合结束」信号
    if (turn.text.trim()) {
      const last = [...this.history].reverse().find((m) => m.role === "assistant");
      if (last) this.events.onAssistantDone(last);
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
