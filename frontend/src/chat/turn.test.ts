// ChatEngine 回合编排单测：打断落账（seenText）、打断→发送排序、
// 麦克风挂起/恢复语义、解析层资源清单过滤。
// 外部依赖全部 mock：chatClient(SSE)、ttsClient、asrClient、capture、player、stage。

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/chatClient", () => ({
  chat: vi.fn(),
  interrupt: vi.fn(() => Promise.resolve()),
}));
vi.mock("../services/ttsClient", () => ({
  streamSpeech: vi.fn(() => Promise.resolve()),
}));
vi.mock("../services/asrClient", () => ({
  AsrStream: class {
    connect(): Promise<void> {
      return Promise.resolve();
    }
    send(): void {}
    close(): void {}
    get open(): boolean {
      return false;
    }
  },
}));
vi.mock("../audio/capture", () => ({
  MicStreamer: class {
    start(): Promise<void> {
      return Promise.resolve();
    }
    cancel(): void {}
    get active(): boolean {
      return false;
    }
  },
}));
vi.mock("../audio/player", () => ({
  TtsPlayer: class {
    onMouthOpen: ((v: number) => void) | null = null;
    onDrain: (() => void) | null = null;
    setVolume(): void {}
    push(): void {}
    stop(): void {}
    dispose(): void {}
    get playing(): boolean {
      return false;
    }
  },
}));
vi.mock("../live2d/stage", () => ({
  getStage: () => ({
    setMouthOpen() {},
    setExpression() {},
    playMotion() {},
    resetExpression() {},
  }),
}));

import { chat, interrupt } from "../services/chatClient";
import { ChatEngine } from "./turn";
import { getSettings, update } from "../lib/store";
import type { ChatMessage } from "../lib/types";

const chatMock = vi.mocked(chat);
const interruptMock = vi.mocked(interrupt);

/** 让微任务链跑完（sendQueue → doSend → runTurn 消费 SSE 全是微任务）。 */
const tick = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

const setVoiceInput = (v: boolean): void => {
  const s = getSettings();
  update({
    settings: { ...s, general: { ...s.general, voiceInput: v } },
  });
};

interface EngineInternals {
  turn: {
    sentences: { text: string; dirs: { kind: string; name: string; offset: number }[] }[];
    disp: { idx: number; reveal: number };
    timer: ReturnType<typeof setInterval>;
  } | null;
}

const internals = (e: ChatEngine): EngineInternals =>
  e as unknown as EngineInternals;

function makeEngine(): { eng: ChatEngine; done: ChatMessage[] } {
  const done: ChatMessage[] = [];
  const eng = new ChatEngine({
    onStatus: () => {},
    onUserMessage: () => {},
    onAssistantStart: () => {},
    onDisplay: () => {},
    onAssistantDone: (m) => done.push(m),
    onError: () => {},
  });
  return { eng, done };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("打断落账一致性（seenText）", () => {
  it("打断时本地落账与回传都是用户实际看到的文本", async () => {
    chatMock.mockImplementation(async function* () {
      yield { t: "delta" as const, text: "第一句。第二句。第三句还在写" };
      yield { t: "done" as const };
    });
    const { eng } = makeEngine();
    eng.sendText("你好");
    await tick();

    const turn = internals(eng).turn;
    expect(turn).toBeTruthy();
    clearInterval(turn!.timer); // 冻结逐字推进，手动摆出演播现场
    turn!.disp.idx = 1; // 第一句已播完，第二句在播
    turn!.disp.reveal = 2; // 第二句露出「第二」两字

    eng.interrupt();
    await tick();
    eng.dispose();

    const roles = eng.history.map((m) => `${m.role}:${m.text}`);
    expect(roles).toEqual(["user:你好", "assistant:第一句。第二"]);
    expect(interruptMock).toHaveBeenCalledWith("你好", "第一句。第二");
  });

  it("一个字都没看到就不落账（assistant 可空）", async () => {
    chatMock.mockImplementation(async function* () {
      yield { t: "delta" as const, text: "还没来得及看。" };
      await new Promise(() => {}); // 回合悬挂，无人看屏
    });
    const { eng, done } = makeEngine();
    eng.sendText("你好");
    await tick();
    expect(internals(eng).turn).toBeTruthy();

    eng.interrupt();
    eng.dispose();

    expect(eng.history.map((m) => m.role)).toEqual(["user"]);
    expect(done).toEqual([]);
    expect(interruptMock).toHaveBeenCalledWith("你好", "");
  });
});

describe("interrupt → send 顺序", () => {
  it("打断回传落地后才发新回合请求", async () => {
    const order: string[] = [];
    chatMock.mockImplementation(async function* (text: string) {
      order.push(`chat:${text}`);
      yield { t: "delta" as const, text: "在写。" };
      await new Promise(() => {}); // 悬挂保持回合存活
    });
    const { eng } = makeEngine();
    eng.sendText("第一轮");
    await tick();
    expect(order).toEqual(["chat:第一轮"]);
    expect(internals(eng).turn).toBeTruthy();

    let release: () => void = () => {};
    interruptMock.mockImplementationOnce(() => {
      order.push("interrupt");
      return new Promise<void>((r) => {
        release = r;
      });
    });
    eng.sendText("第二轮");
    await tick();
    // 打断回传未完成：新回合请求不得先发出
    expect(order).toEqual(["chat:第一轮", "interrupt"]);

    release();
    await tick();
    expect(order).toEqual(["chat:第一轮", "interrupt", "chat:第二轮"]);
    eng.dispose();
  });
});

describe("麦克风开关语义", () => {
  it("挂起时记住意向，回来恢复", async () => {
    const { eng } = makeEngine();
    await eng.startListening();
    expect(eng.listening).toBe(true);

    eng.suspendMic();
    expect(eng.listening).toBe(false);

    eng.resumeMic();
    await tick();
    expect(eng.listening).toBe(true);
    eng.dispose();
  });

  it("挂起中手动关麦（stopListening）清意向，回来不恢复", async () => {
    const { eng } = makeEngine();
    await eng.startListening();
    eng.suspendMic();
    eng.stopListening();

    eng.resumeMic();
    await tick();
    expect(eng.listening).toBe(false);
    eng.dispose();
  });

  it("挂起期间设置页关掉 voiceInput，回来不恢复", async () => {
    const { eng } = makeEngine();
    await eng.startListening();
    eng.suspendMic();
    setVoiceInput(false);
    try {
      eng.resumeMic();
      await tick();
      expect(eng.listening).toBe(false);
    } finally {
      setVoiceInput(true);
      eng.dispose();
    }
  });

  it("voiceInput 关着时 startListening 不启动", async () => {
    const { eng } = makeEngine();
    setVoiceInput(false);
    try {
      await eng.startListening();
      expect(eng.listening).toBe(false);
    } finally {
      setVoiceInput(true);
      eng.dispose();
    }
  });
});

describe("解析层资源清单过滤", () => {
  it("清单外指令静默丢弃、清单内随句携带（内置形象清单）", async () => {
    // 内置 Hiyori：expressions 空表、motions 含 Idle/0…8 与 TapBody/0。
    chatMock.mockImplementation(async function* () {
      yield {
        t: "delta" as const,
        text: "好<exp>bad_exp</exp>。<motion>Idle/0</motion>呐<motion>Nope/9</motion>！",
      };
      yield { t: "done" as const };
    });
    const { eng } = makeEngine();
    eng.sendText("hi");
    await tick();
    const turn = internals(eng).turn;
    expect(turn).toBeTruthy();
    clearInterval(turn!.timer);

    expect(turn!.sentences.map((s) => s.text)).toEqual(["好。", "呐！"]);
    // exp 不在清单（expressions 为空）→ 丢；Nope/9 不在 motions → 丢；
    // Idle/0 在清单 → 挂在「呐！」上（offset=0，指令在句首）。
    expect(turn!.sentences[0].dirs).toEqual([]);
    expect(turn!.sentences[1].dirs).toEqual([
      { kind: "motion", name: "Idle/0", offset: 0 },
    ]);
    eng.dispose();
  });

  it("指令 offset 按 trim 后句文本折算（前导空白不计）", async () => {
    chatMock.mockImplementation(async function* () {
      yield {
        t: "delta" as const,
        text: "  你好<motion>Idle/0</motion>还有半句。",
      };
      yield { t: "done" as const };
    });
    const { eng } = makeEngine();
    eng.sendText("hi");
    await tick();
    const turn = internals(eng).turn;
    expect(turn).toBeTruthy();
    clearInterval(turn!.timer);

    // pending="  你好"（4）但句成「你好还有半句。」——指令在「你好」后，offset=2。
    expect(turn!.sentences[0].dirs).toEqual([
      { kind: "motion", name: "Idle/0", offset: 2 },
    ]);
    eng.dispose();
  });
});
