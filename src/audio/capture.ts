// 麦克风采集：getUserMedia → AudioWorklet → 重采样 16k → s16le 分帧回调。
// 与 momo 的差异：sink 直接是字节回调（由 ASR websocket 消费），无 ws 信令。
// worklet 以 Blob URL 内联加载（dev/build 一致、不经 bundler）。

import { ASR_SAMPLE_RATE, S16leFramer } from "./pcm";

export interface MicStreamOpts {
  /** 设备断开 / worklet 失败等异步错误。 */
  onError?: (err: unknown) => void;
  /** 帧长毫秒（默认 50ms → 1600B@16kHz）。 */
  frameMs?: number;
}

// AudioWorklet 处理器源码：把 input channel 0 的 Float32 chunk 原样回传主线程。
const WORKLET_NAME = "momo-pcm-capture";
const WORKLET_SOURCE = `class MomoPcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch);
    return true;
  }
}
registerProcessor("${WORKLET_NAME}", MomoPcmCapture);
`;

export class MicStreamer {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private workletUrl: string | null = null;

  private onChunk: ((pcm: Uint8Array) => void) | null = null;
  private framer: S16leFramer | null = null;
  private onError: ((err: unknown) => void) | null = null;
  private _active = false;

  get active(): boolean {
    return this._active;
  }

  /** 请求麦克风并开始推帧。权限拒绝/设备缺失时抛错并释放资源。 */
  async start(
    onChunk: (pcm: Uint8Array) => void,
    opts?: MicStreamOpts,
  ): Promise<void> {
    if (this._active) this.cancel();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    try {
      this.stream = stream;
      this.onChunk = onChunk;
      this.onError = opts?.onError ?? null;

      // AudioContext 用设备原生采样率，重采样在 S16leFramer 内完成
      // （强制 sampleRate 的构造在部分 webview 上不受支持）。
      const ctx = new AudioContext();
      this.ctx = ctx;
      if (!this.workletUrl) {
        this.workletUrl = URL.createObjectURL(
          new Blob([WORKLET_SOURCE], { type: "text/javascript" }),
        );
      }
      await ctx.audioWorklet.addModule(this.workletUrl);
      await ctx.resume();

      // stop/cancel（或并发 start 挤占）在异步间隙发生 → 清理本次资源后退出。
      // teardown 已跑过则是幂等空操作。
      if (this.stream !== stream || this.ctx !== ctx) {
        stream.getTracks().forEach((t) => t.stop());
        if (ctx.state !== "closed") void ctx.close().catch(() => {});
        return;
      }

      this.framer = new S16leFramer(ctx.sampleRate, ASR_SAMPLE_RATE, opts?.frameMs ?? 50);
      this.source = this.ctx.createMediaStreamSource(stream);
      this.node = new AudioWorkletNode(this.ctx, WORKLET_NAME);
      this.node.port.onmessage = (ev: MessageEvent<Float32Array>) => this.onPcm(ev.data);
      this.source.connect(this.node);
      // 处理器不产出声音，接 destination 仅为驱动渲染线程拉流。
      this.node.connect(this.ctx.destination);

      // 设备拔除/系统回收 → cancel + 错误回给上层。
      const track = stream.getAudioTracks()[0];
      if (track) {
        track.addEventListener("ended", () => {
          if (!this._active) return;
          const onError = this.onError;
          this.cancel();
          onError?.(new Error("microphone track ended"));
        });
      }
      this._active = true;
    } catch (err) {
      this.teardown();
      throw err;
    }
  }

  /** 正常结束：flush 残余帧后释放。 */
  stop(): void {
    const tail = this.framer?.flush() ?? null;
    if (tail && tail.byteLength > 0) this.onChunk?.(tail);
    this.teardown();
  }

  /** 立即释放（不打尾帧）。幂等。 */
  cancel(): void {
    this.teardown();
  }

  /** worklet 回传的 Float32 chunk → 重采样 → 定长帧 → 回调。 */
  private onPcm(chunk: Float32Array): void {
    if (!this._active || !this.onChunk || !this.framer) return;
    for (const frame of this.framer.push(chunk)) {
      this.onChunk(frame);
    }
  }

  private teardown(): void {
    this._active = false;
    this.onChunk = null;
    this.framer = null;
    this.onError = null;
    this.node?.disconnect();
    this.source?.disconnect();
    this.node = null;
    this.source = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    // AudioContext 随 capture 生灭，close 异步不阻塞。
    if (this.ctx && this.ctx.state !== "closed") {
      void this.ctx.close().catch(() => {});
    }
    this.ctx = null;
  }
}
