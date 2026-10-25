import { afterEach, describe, expect, it, vi } from "vitest";
import { createAsr, parseBuiltinEvent } from "./asrClient";

describe("parseBuiltinEvent", () => {
  it("解析 transcript / speech_started / error", () => {
    expect(parseBuiltinEvent('{"type":"transcript","text":"你好"}')).toEqual({
      type: "transcript",
      text: "你好",
      message: undefined,
    });
    expect(parseBuiltinEvent('{"type":"speech_started"}')?.type).toBe(
      "speech_started",
    );
    expect(
      parseBuiltinEvent('{"type":"error","message":"模型缺失"}')?.message,
    ).toBe("模型缺失");
  });

  it("非法 JSON / 缺 type 一律 null（协议演进时静默忽略）", () => {
    expect(parseBuiltinEvent("not json")).toBeNull();
    expect(parseBuiltinEvent("[]")).toBeNull();
    expect(parseBuiltinEvent('{"text":"x"}')).toBeNull();
  });
});


class FakeSocket {
  static OPEN = 1;
  static current: FakeSocket;
  readyState = 1;
  binaryType = "";
  onmessage?: (ev: {data: string}) => void;
  onclose?: (ev: {code: number}) => void;
  onerror?: () => void;
  send = vi.fn();
  close = vi.fn();
  constructor(readonly url: string) { FakeSocket.current = this; }
  emit(data: object) { this.onmessage?.({data: JSON.stringify(data)}); }
}
afterEach(() => {vi.unstubAllGlobals(); vi.useRealTimers();});
it("uses only the builtin socket, and stop discards late transcription", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("location", {protocol: "http:", host: "localhost:5173"});
  const onTranscript = vi.fn();
  const asr = createAsr({onTranscript});
  const pending = asr.connect();
  const ws = FakeSocket.current;
  expect(ws.url).toBe("ws://localhost:5173/api/asr/stream");
  ws.emit({type: "ready"});
  await pending;
  ws.emit({type: "transcript", text: "你好"});
  expect(onTranscript).toHaveBeenCalledWith("你好");
  asr.close();
  ws.emit({type: "transcript", text: "已经停止"});
  expect(onTranscript).toHaveBeenCalledTimes(1);
  await vi.runAllTimersAsync();
  expect(ws.close).toHaveBeenCalledWith(1000);
});
