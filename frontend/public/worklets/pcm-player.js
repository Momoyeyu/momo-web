// 下行 PCM 播放 worklet：主线程推入的 Float32 chunk 按 FIFO 逐帧排播，
// 每 RMS_BLOCKS 个渲染块上报一次输出 RMS（lipsync 驱动），队列播空上报 drain。
//
// 协议（port message）：
//   in : { type: "push", samples: Float32Array }   追加一段待播采样（24kHz mono）
//   in : { type: "pause", paused: boolean }        保留游标，暂停 / 继续排播
//   in : { type: "clear" }                          清空缓冲（barge-in / stop）
//   out: { type: "rms", rms: number }               输出能量（含静音块，自然归零）
//   out: { type: "drain" }                          队列播空，提示口型复位

// 8 块 × 128 采样 ≈ 42.7ms @24kHz：嘴型更新 ~23Hz，够顺滑又不过载 port。
var RMS_BLOCKS = 8;

class PcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = []; // Float32Array 队列
    this.offset = 0; // 队首已消费偏移
    this.blocks = 0; // 距上次 RMS 上报的块数
    this.sumSq = 0; // 累计平方和
    this.count = 0; // 累计采样数
    this.wasEmpty = true;
    this.paused = false;
    this.port.onmessage = (event) => {
      var msg = event.data;
      if (msg && msg.type === "push" && msg.samples) {
        this.chunks.push(msg.samples);
      } else if (msg && msg.type === "pause") {
        this.paused = !!msg.paused;
        this.blocks = 0;this.sumSq = 0;this.count = 0;
      } else if (msg && msg.type === "clear") {
        this.chunks = [];
        this.offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    var out = outputs[0][0];
    if (this.paused) {out.fill(0);return true;}
    var n = out.length;
    var written = 0;
    while (written < n && this.chunks.length > 0) {
      var head = this.chunks[0];
      var take = Math.min(n - written, head.length - this.offset);
      out.set(head.subarray(this.offset, this.offset + take), written);
      this.offset += take;
      written += take;
      if (this.offset >= head.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    if (written < n) out.fill(0, written);

    var sum = 0;
    for (var i = 0; i < n; i++) sum += out[i] * out[i];
    this.sumSq += sum;
    this.count += n;
    this.blocks += 1;
    if (this.blocks >= RMS_BLOCKS) {
      this.port.postMessage({
        type: "rms",
        rms: this.count > 0 ? Math.sqrt(this.sumSq / this.count) : 0,
      });
      this.blocks = 0;
      this.sumSq = 0;
      this.count = 0;
    }

    var empty = this.chunks.length === 0;
    if (empty && !this.wasEmpty) {
      this.port.postMessage({ type: "drain" });
    }
    this.wasEmpty = empty;
    return true;
  }
}

registerProcessor("pcm-player", PcmPlayerProcessor);
