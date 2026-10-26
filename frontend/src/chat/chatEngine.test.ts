// ChatEngine 回合编排单测：打断落账（seenText）、打断→发送排序、
// 麦克风挂起/恢复语义、解析层资源清单过滤。
// 外部依赖全部 mock：chatClient(SSE)、ttsClient、asrClient、capture、player、stage。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/chatClient", () => ({
  chat: vi.fn(),
  interrupt: vi.fn(() => Promise.resolve()),
  acknowledgeDisplay: vi.fn(() => Promise.resolve()),
}));
vi.mock("../services/meetingClient", () => ({
  meetingIdentity: vi.fn<() => {clientId:string;leaseId:string}|undefined>(() => undefined),
  acknowledgePresentation: vi.fn(() => Promise.resolve()),
  acquireReplay: vi.fn(),
}));
vi.mock("../services/ttsClient", () => ({
  streamSpeech: vi.fn(() => Promise.resolve()),
}));
vi.mock("../services/asrClient", () => ({
  createAsr: vi.fn(() => ({
    connect: (): Promise<void> => Promise.resolve(),
    send: (): void => {},
    close: (): void => {},
  })),
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
    cancelPerformance() {}, beginPerformance() {}, endPerformance() {}, applyCue() {},
    getPresentation() { return { avatarId: "runtime-model", revision: "r1", expressions: [{name: "happy", desc: "开心"}], motions: [], expressionState: {name: null, intensity: 0} }; },
  }),
}));

import { MicStreamer } from "../audio/capture";
import { createAsr } from "../services/asrClient";
import { chat, interrupt, acknowledgeDisplay } from "../services/chatClient";
import { acknowledgePresentation, meetingIdentity } from "../services/meetingClient";
import { ChatEngine } from "./chatEngine";
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
  displayTick(turn: NonNullable<EngineInternals["turn"]>): void;
  turn: {
    sentences: { text: string; cues: import("../live2d/performanceTypes").PerformanceCue[] }[];
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
    onSentence: () => {},
    onAssistantDone: (m) => done.push(m),
    onError: () => {},
  });
  return { eng, done };
}

beforeEach(() => {
  // 出厂配置不再预填任何服务地址（新用户 clone 后自己填），而引擎在 llm.url 为空
  // 时会拒绝发回合。所以这里显式注入一份假的 —— 测试不该依赖「仓库预填了地址」。
  update({
    settings: {
      ...getSettings(),
      llm: { url: "http://llm.test", key: "", model: "test-model", thinking: false },
      tts: { url: "http://tts.test", key: "", voice: "", prompt: "" },
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.mocked(meetingIdentity).mockReturnValue(undefined);
});

describe("打断落账一致性（seenText）", () => {
  it("打断时本地落账与回传都是用户实际看到的文本", async () => {
    chatMock.mockImplementation(async function* () {
      for (const [no, text] of ["第一句。", "第二句。", "第三句。"].entries()) {
        yield { t: "sentence" as const, no, text, cues: [], at: "" };
      }
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

    expect(eng.history[0]).toMatchObject({role:"user",text:"你好"});
    expect(eng.history.filter(message=>message.role==="assistant").map(message=>message.text).join("")).toBe("第一句。第二");
    expect(interruptMock).toHaveBeenCalledWith("你好", "第一句。第二");
  });

  it("一个字都没看到就不落账（assistant 可空）", async () => {
    chatMock.mockImplementation(async function* () {
      yield { t: "sentence" as const, no: 0, text: "还没来得及看。", cues: [], at: "" };
      await new Promise(() => {}); // 回合悬挂，无人看屏
    });
    const { eng, done } = makeEngine();
    eng.sendText("你好");
    await tick();
    expect(internals(eng).turn).toBeTruthy();

    eng.interrupt();
    await tick();
    eng.dispose();

    expect(eng.history.map((m) => m.role)).toEqual([]);
    expect(done).toEqual([]);
    expect(interruptMock).toHaveBeenCalledWith("你好", "");
  });
});

describe("interrupt → send 顺序", () => {
  it("打断回传落地后才发新回合请求", async () => {
    const order: string[] = [];
    chatMock.mockImplementation(async function* (text: string) {
      order.push(`chat:${text}`);
      yield { t: "sentence" as const, no: 0, text: "在写。", cues: [], at: "" };
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

  it("stop during pending builtin connection never reopens the microphone", async () => {
    let ready!: () => void;
    const connect = new Promise<void>(resolve => { ready = resolve; });
    const close = vi.fn();
    vi.mocked(createAsr).mockReturnValueOnce({connect: () => connect, send: () => {}, close});
    const {eng} = makeEngine();
    const opening = eng.startListening();
    expect(eng.microphoneActive).toBe(true);
    eng.stopListening();
    expect(eng.microphoneActive).toBe(false);
    ready();
    await opening;
    expect(eng.listening).toBe(false);
    expect(close).toHaveBeenCalled();
    eng.dispose();
  });

  it("ASR disconnect during permission wait invalidates activation and releases a late microphone", async () => {
    let allow!: () => void;
    let disconnected: ((code: number) => void) | undefined;
    const permission = new Promise<void>(resolve => { allow = resolve; });
    const start = vi.spyOn(MicStreamer.prototype, "start").mockImplementationOnce(() => permission);
    const cancel = vi.spyOn(MicStreamer.prototype, "cancel");
    vi.mocked(createAsr).mockImplementationOnce(events => {
      disconnected = events.onClose;
      return {connect: async () => {}, send: () => {}, close: () => {}};
    });
    const {eng} = makeEngine();
    const opening = eng.startListening();
    await tick();
    disconnected?.(1006);
    const cancellations = cancel.mock.calls.length;
    allow();
    await opening;
    expect(eng.listening).toBe(false);
    expect(eng.microphoneActive).toBe(false);
    expect(cancel.mock.calls.length).toBeGreaterThan(cancellations);
    eng.dispose();
    start.mockRestore();cancel.mockRestore();
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
  it("sends the actual runtime model catalog with each request", async () => {
    chatMock.mockImplementation(async function* () {
      yield { t: "sentence" as const, no: 0, text: "好。", cues: [], at: "" };
      yield { t: "done" as const };
    });
    const { eng } = makeEngine(); eng.sendText("hi"); await tick();
    expect(chatMock.mock.calls.at(-1)?.[2]).toMatchObject({ avatarId: "runtime-model", revision: "r1" });
    eng.dispose();
  });

  it("已展示的句子即时进入 backlog，未展示的队列不进入记录", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    chatMock.mockImplementation(async function* () {
      yield { t: "sentence" as const, no: 0, text: "第一句。", cues: [], at: "" };
      await gate; // 回合悬停：后面的句子还没到
      yield { t: "sentence" as const, no: 1, text: "第二句。", cues: [], at: "" };
      yield { t: "done" as const };
    });
    const { eng } = makeEngine();
    eng.sendText("hi");
    await tick();

    const turn = internals(eng).turn!;clearInterval(turn.timer);
    expect(eng.history).toEqual([]);
    turn.disp.reveal=4;internals(eng).displayTick(turn);
    expect(eng.history.map((m) => m.text)).toEqual(["hi", "第一句。"]);

    release();
    await tick();
    expect(eng.history.map((m) => m.text)).toEqual(["hi", "第一句。"]);
    turn.disp.idx=1;turn.disp.reveal=4;internals(eng).displayTick(turn);
    expect(eng.history.map((m) => m.text)).toEqual(["hi", "第一句。", "第二句。"]);
    eng.dispose();
  });
});
describe('unanswered request failures', () => {
  it.each(['network', 'error event', 'empty stream'])('removes only the pending user message after %s', async (kind) => {
    chatMock.mockImplementation(async function* () {
      if (kind === 'network') throw new Error('network down');
      if (kind === 'error event') yield { t: 'error' as const, message: 'upstream refused' };
    });
    const { eng } = makeEngine();
    eng.loadHistory([{ role: 'user', text: 'previous question', at: 't' }, { role: 'assistant', text: 'previous answer', at: 't' }]);
    eng.sendText('failed message');
    await tick();
    expect(eng.history.map(m => m.text)).toEqual(['previous question', 'previous answer']);
    expect(eng.status).toBe('idle');
    eng.dispose();
  });

  it('retains the exchange if a real sentence arrived before failure', async () => {
    chatMock.mockImplementation(async function* () {
      yield { t: 'sentence' as const, no: 0, text: 'A real reply.', cues: [], at: '' };
      throw new Error('stream disconnected');
    });
    const { eng } = makeEngine();
    eng.sendText('question');
    await tick();
    const turn=internals(eng).turn!;clearInterval(turn.timer);turn.disp.reveal=13;internals(eng).displayTick(turn);
    expect(eng.history.map(m => m.text)).toEqual(['question', 'A real reply.']);
    eng.dispose();
  });
});

describe('restored local avatar caption', () => {
  it.each([
    {
      name: 'keeps the last local sentence when newer QQ, WeChat and other plugin replies exist',
      messages: [
        {role:'assistant' as const,text:'local last sentence',at:'t',source:'meeting'},
        {role:'assistant' as const,text:'QQ private reply',at:'t',source:'qq'},
        {role:'assistant' as const,text:'WeChat private reply',at:'t',source:'wechat'},
        {role:'assistant' as const,text:'another plugin reply',at:'t',source:'future-channel'},
      ],
      caption: 'local last sentence',
    },
    {
      name: 'leaves the avatar caption empty when only remote conversations were restored',
      messages: [
        {role:'assistant' as const,text:'QQ private reply',at:'t',source:'qq'},
        {role:'assistant' as const,text:'WeChat private reply',at:'t',source:'wechat'},
      ],
      caption: '',
    },
    {
      name: 'preserves the caption of legacy local history without source metadata',
      messages: [
        {role:'assistant' as const,text:'legacy local sentence',at:'t'},
        {role:'user' as const,text:'new local question',at:'t',source:'meeting'},
        {role:'assistant' as const,text:'QQ private reply',at:'t',source:'qq'},
      ],
      caption: 'legacy local sentence',
    },
  ])('$name', ({messages,caption}) => {
    const {eng} = makeEngine();
    try {
      eng.loadHistory(messages);
      expect(eng.display).toBe(caption);
      expect(eng.status).toBe('idle');
      expect(eng.history.map(({role,text,source})=>({role,text,source})))
        .toEqual(messages.map(({role,text,...metadata})=>({role,text,source:'source' in metadata?metadata.source:undefined})));
    } finally {
      eng.dispose();
    }
  });
});

describe('scripted first meeting', () => {
  it('plays an assistant-only opening through the existing sentence queue once', async () => {
    chatMock.mockImplementation(async function* () {
      yield { t: 'sentence' as const, no: 0, text: '我叫 momo。', cues: [], at: '' };
      yield { t: 'done' as const };
    });
    const { eng } = makeEngine();
    eng.beginFirstMeeting();
    eng.beginFirstMeeting();
    await tick();
    expect(chatMock).toHaveBeenCalledTimes(1);
    const turn=internals(eng).turn!;clearInterval(turn.timer);turn.disp.reveal=8;internals(eng).displayTick(turn);
    expect(eng.history.map(m => [m.role, m.text])).toEqual([['assistant', '我叫 momo。']]);
    expect(chatMock.mock.calls[0][3]).toBe(true);
    eng.dispose();
  });
});


describe("durable displayed transcript", () => {
  it("does not publish unseen generated sentences and acknowledges only the shown prefix", async () => {
    chatMock.mockImplementation(async function* () {
      yield {t:"sentence" as const,no:0,text:"第一句还很长。",cues:[],at:"t",runId:"server-run",eventId:"server-event",seq:2,generation:7,userEventId:"server-user",userSeq:1};
      yield {t:"sentence" as const,no:1,text:"未展示的第二句。",cues:[],at:"t",runId:"server-run",eventId:"server-event-2",seq:3,generation:7};
      await new Promise(() => {});
    });
    const {eng} = makeEngine();eng.sendText("你好");await tick();
    const turn = internals(eng).turn!;clearInterval(turn.timer);
    expect(eng.history).toEqual([]);
    turn.disp.reveal=2;
    eng.interrupt();await tick();
    expect(eng.history.map(message => ({role:message.role,text:message.text,runId:message.runId}))).toEqual([{role:"user",text:"你好",runId:"server-run"},{role:"assistant",text:"第一",runId:"server-run"}]);
    expect(acknowledgeDisplay).toHaveBeenCalledWith("server-run",7,"第一");
    eng.dispose();
  });
});

it('pauses displayed text and ACK behind subpages, then resumes the same reply',async()=>{
  update({settings:{...getSettings(),general:{...getSettings().general,textSpeed:100}}});
  chatMock.mockImplementation(async function*(){
    yield {t:'sentence' as const,no:0,text:'这一句等你回来。',cues:[],at:'t',runId:'held-run',eventId:'held-event',generation:8};
    await new Promise(()=>{});
  });
  const {eng}=makeEngine();eng.sendText('hello');eng.setSceneActive(false);await tick();
  const turn=internals(eng).turn!;clearInterval(turn.timer);
  for(let index=0;index<4;index++)internals(eng).displayTick(turn);
  expect(eng.history).toEqual([]);expect(acknowledgeDisplay).not.toHaveBeenCalled();
  eng.setSceneActive(true);internals(eng).displayTick(turn);await tick();
  expect(eng.history.at(-1)).toMatchObject({eventId:'held-event',text:'这一句等你回来。'});
  expect(acknowledgeDisplay).toHaveBeenCalledWith('held-run',8,'这一句等你回来。');
  eng.dispose();
});

it('stops each capability delivered while hidden and resumes the newest one',async()=>{
  vi.mocked(meetingIdentity).mockReturnValue({clientId:'test-client',leaseId:'test-lease'});
  let releaseSecond:()=>void=()=>{};
  const second=new Promise<void>(resolve=>{releaseSecond=resolve;});
  chatMock.mockImplementation(async function*(){
    yield {t:'sentence' as const,no:0,text:'第一句。',cues:[],at:'t',runId:'held-run',eventId:'first',generation:8,presentationToken:'token-a'};
    await second;
    yield {t:'sentence' as const,no:1,text:'第二句。',cues:[],at:'t',runId:'held-run',eventId:'second',generation:8,presentationToken:'token-b'};
    await new Promise(()=>{});
  });
  const {eng}=makeEngine();
  eng.sendText('hello');eng.setSceneActive(false);await tick();
  releaseSecond();await tick(5);
  const stopped=vi.mocked(acknowledgePresentation).mock.calls.filter(call=>call[3]==='stopped');
  expect(stopped.map(call=>call[1])).toEqual(['token-a','token-b']);
  eng.setSceneActive(true);
  await new Promise(resolve=>setTimeout(resolve,400));
  expect(vi.mocked(acknowledgePresentation).mock.calls.filter(call=>call[3]==='resume').map(call=>call[1])).toEqual(['token-b']);
  eng.dispose();
});
