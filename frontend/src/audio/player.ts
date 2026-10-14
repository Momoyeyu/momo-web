// TTS 下行播放：s16le 24kHz mono → AudioWorklet(public/worklets/pcm-player.js)
// 环形缓冲排播；worklet 上报输出 RMS → 平滑 → onMouthOpen(0..1) 驱动口型；
// 队列播空上报 drain → onDrain。

import { s16leToFloat32 } from "./pcm";

/** 口型平滑系数：张开快（attack）、收拢慢（release）。 */
const MOUTH_ATTACK = 0.6;
const MOUTH_RELEASE = 0.25;
/** RMS→口型增益：小音量也能把嘴张开到可见幅度。 */
const MOUTH_GAIN = 3;

interface WorkletOutMsg {
  type?: string;
  rms?: number;
}

export class TtsPlayer {
  /** 嘴型输出（0..1），接到 Live2DStage.setMouthOpen。 */
  onMouthOpen: ((value: number) => void) | null = null;
  /** 播放队列播空（一句话/一轮播完）。 */
  onDrain: (() => void) | null = null;

  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private initPromise: Promise<void> | null = null;
  /** worklet 就绪前积压的 Float32 chunk。 */
  private pending: Float32Array[] = [];
  private mouth = 0;
  private _playing = false;
  private volume = 1;

  /** 语音音量 0..1，即时生效（含播放中）。 */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  /**
   * 推入一段 s16le 24kHz mono PCM（内部转 Float32 入 worklet）。
   * AudioContext 需要用户手势后才能 resume —— init 在首次 push 时 lazy 进行。
   */
  push(pcm: Uint8Array): void {
    const samples = s16leToFloat32(pcm);
    this.ensure();
    if (this.node) {
      this.node.port.postMessage({ type: "push", samples }, [samples.buffer]);
    } else {
      this.pending.push(samples);
    }
    this._playing = true;
  }

  /** barge-in / stop：清空播放缓冲并立即静音，口型复位。 */
  stop(): void {
    this.pending = [];
    this.node?.port.postMessage({ type: "clear" });
    this._playing = false;
    if (this.mouth !== 0) {
      this.mouth = 0;
      this.onMouthOpen?.(0);
    }
  }

  /** 是否仍有待播音频（近似：push 置位，drain/stop 复位）。 */
  get playing(): boolean {
    return this._playing;
  }

  /** 释放 AudioContext（页面卸载）。 */
  dispose(): void {
    this.stop();
    this.node?.disconnect();
    this.node = null;
    this.gain?.disconnect();
    this.gain = null;
    if (this.ctx && this.ctx.state !== "closed") {
      void this.ctx.close().catch(() => {});
    }
    this.ctx = null;
    this.initPromise = null;
  }

  /** lazy init + 每次 push 尝试 resume（首次 push 通常发生在用户手势回调里）。 */
  private ensure(): void {
    if (!this.initPromise) {
      this.initPromise = this.init().catch(() => {
        // 加载失败（如 worklet 404）：重置允许下次 push 重试，ctx 复用。
        this.initPromise = null;
      });
    }
    if (this.ctx && this.ctx.state !== "closed") {
      void this.ctx.resume().catch(() => {});
    }
  }

  private async init(): Promise<void> {
    const ctx = this.ctx ?? new AudioContext({ sampleRate: 24000 });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule("/worklets/pcm-player.js");
    // init 期间被 dispose → ctx 已换主，放弃建图。
    if (this.ctx !== ctx) return;
    const node = new AudioWorkletNode(ctx, "pcm-player");
    node.port.onmessage = (ev: MessageEvent<WorkletOutMsg>) => this.onWorkletMsg(ev.data);
    const gain = ctx.createGain();
    gain.gain.value = this.volume;
    node.connect(gain);
    gain.connect(ctx.destination);
    this.gain = gain;
    this.node = node;
    // 补推就绪前积压的 chunk（保持顺序）。
    const queued = this.pending;
    this.pending = [];
    for (const samples of queued) {
      node.port.postMessage({ type: "push", samples }, [samples.buffer]);
    }
  }

  private onWorkletMsg(msg: WorkletOutMsg): void {
    if (!msg) return;
    if (msg.type === "rms") {
      const target = Math.min(1, (msg.rms ?? 0) * MOUTH_GAIN);
      const k = target > this.mouth ? MOUTH_ATTACK : MOUTH_RELEASE;
      this.mouth += (target - this.mouth) * k;
      this.onMouthOpen?.(this.mouth);
    } else if (msg.type === "drain") {
      this._playing = false;
      this.mouth = 0;
      this.onMouthOpen?.(0);
      this.onDrain?.();
    }
  }
}
