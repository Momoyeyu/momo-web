// 标题页「心跳」特效导演：Canvas 2D，一场一景循环轮换，主旨统一为一颗不太对劲的心脏。
//   - 场景 ecg   ：写实监护仪心电。琥珀磷光迹线带余晖衰减，扫描头右进左抹；
//                  闪电式断线（段级 dropout + 全局硬切）；偶发室早/漏搏/短阵速搏，
//                  极低概率短暂停搏后一记重搏恢复。
//   - 场景 rings ：心音涟漪。lub-dub 双搏各扩散一圈，搏间近乎全暗。
//   - 场景 ghost ：重影。回声轨延迟漂移、渐渐与主轨失同步——恐怖谷的复制心。
// 场景按完整周期登场收场，绝不半途切换：ecg/ghost = 整两轮左→右扫描，
// rings = 整三搏（最后一圈涟漪散尽才收）。场景间留 3~5.5s 纯黑间歇
// （只余极暗呼吸暗角）——黑场本身就是张力的一部分；R 峰触发全屏微光脉冲。
// 无第三方渲染依赖；prefers-reduced-motion 出静态帧；页面隐藏/离屏停帧。

import { useEffect, useRef } from "react";
import { drawGrid } from "../lib/grid";

type SceneKind = "ecg" | "rings" | "ghost";
type BeatKind = "normal" | "pvc";

const BG = "#16121a"; // var(--bg)
const CORE = "#fdf3d8"; // 迹线白热核心
const GLOW = "234,182,84"; // var(--accent) 的 RGB，磷光晕
const ECHO = "176,164,143"; // var(--text-dim)，重影去饱和
const GRID_TILT = 12; // 标题页网格固定倾角（度）——与设置/存档页的 RoPE 落角区分

const FADE = 0.9; // 场景淡入/淡出时长 s
const R_PHASE = 0.275; // R 峰在一个心动周期内的相位
const TRACE_SPEED = 0.22; // 扫描头速度（屏宽/秒）
const TRACE_SWEEP = 1 / TRACE_SPEED; // 扫描头跑满一屏一轮 ≈ 4.5s
const TRACE_SWEEPS = 2; // ecg/ghost 固定整两轮再收，不在半途切换
const RING_LIFE = 1.6; // 一圈涟漪从诞生到散尽
const RING_BEATS = 3; // rings 固定三搏再收
// 涟漪落点候选（舞台相对坐标）：集中在左中区域，避开右侧菜单与左上品牌；
// 每场随机抽 RING_BEATS 个，每搏换一处——同一场里三颗“心音”不在同一点。
const RING_SPOTS: [number, number][] = [
  [0.28, 0.46], [0.38, 0.56], [0.46, 0.40],
  [0.24, 0.60], [0.34, 0.38], [0.44, 0.62],
];

const hash = (n: number): number => {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
};
const smooth = (t: number): number => t * t * (3 - 2 * t);
const rand = (a: number, b: number): number => a + Math.random() * (b - a);

// 写实 ECG 复合波：P-QRS-T 各段为高斯叠加，p∈[0,1) 为一次心跳
const gauss = (p: number, c: number, w: number): number =>
  Math.exp(-(((p - c) / w) ** 2));

function ecgWave(p: number, kind: BeatKind): number {
  if (kind === "pvc") {
    // 室性早搏：宽大畸形 QRS + 倒置 T，看不到前置 P 波
    return (
      -0.42 * gauss(p, 0.24, 0.05) +
      0.85 * gauss(p, 0.34, 0.055) -
      0.3 * gauss(p, 0.6, 0.07)
    );
  }
  return (
    0.12 * gauss(p, 0.13, 0.03) - // P
    0.09 * gauss(p, 0.245, 0.009) + // Q
    1.0 * gauss(p, 0.275, 0.0075) - // R
    0.2 * gauss(p, 0.305, 0.011) + // S
    0.26 * gauss(p, 0.52, 0.045) // T
  );
}

interface Beat {
  start: number;
  rr: number;
  kind: BeatKind;
  amp: number;
  fired: boolean; // R 峰事件是否已触发
}

interface Ring {
  t0: number;
  strong: boolean;
  cx: number; // 舞台相对坐标 0..1
  cy: number;
}

// 迹线列缓冲：每列记录最后写入的波形高度与时间，渲染时按年龄做磷光衰减
interface TraceBuf {
  y: Float32Array;
  ts: Float64Array;
  head: number;
}

function makeTrace(width: number): TraceBuf {
  return { y: new Float32Array(width), ts: new Float64Array(width), head: 0 };
}

export default function EcgCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let disposed = false;
    let raf = 0;
    let last = 0;
    let now = 0; // 特效内部时钟（s），暂停时不推进
    let visible = true;

    let W = 0;
    let H = 0;
    let gridCanvas: HTMLCanvasElement | null = null;
    let vignette: CanvasGradient | null = null;
    let headGlow: CanvasGradient | null = null;

    // ---- 导演状态 ----
    const order: SceneKind[] = ["ecg", "rings", "ecg", "ghost"];
    let orderIdx = 0;
    let scene: SceneKind = "ecg";
    let sceneT = -0.7; // 场景内时间；负值 = 开场前的全黑停顿
    let sceneDur = TRACE_SWEEP * TRACE_SWEEPS + 0.15;
    let gapDur = 0;

    // ---- 节律器 ----
    let rrBase = 0.92; // ~65bpm，缓慢漂移
    let beat: Beat = { start: 0.2, rr: rrBase, kind: "normal", amp: 1, fired: false };
    let tachyLeft = 0;
    let compensatory = false;
    let flash = 0; // R 峰闪光强度，指数衰减
    let flatUntil = 0; // 停搏截止时间
    let nextScare = rand(30, 55); // 下一次停搏惊吓
    let flatResumeBeat = false;

    // ---- 闪烁状态（仅 ecg/ghost） ----
    let glitchUntil = 0; // 全局硬切结束时间
    let nextGlitch = rand(3.5, 8);
    let burstUntil = 0; // 段级干扰增强结束时间
    let nextBurst = rand(6, 13);

    // ---- 迹线与涟漪 ----
    let main = makeTrace(0);
    let echo = makeTrace(0);
    let echoDelay = 0.22;
    let rings: Ring[] = [];
    let ringPlan: [number, number][] = []; // 本场抽中的落点序列（一搏一处）
    let ringsShown = 0; // rings 场景已搏次数

    const resize = (): void => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      W = w;
      H = h;
      main = makeTrace(w);
      echo = makeTrace(w);

      // 网格预渲染：与设置页共用同一把标尺（lib/grid）。
      // 标题页有自己的固定倾角——心电迹线是水平的，网格微微歪着，
      // 「仪器没摆正」的错位感正贴恐怖谷主题，也和设置页的 RoPE 落角区分开。
      gridCanvas = document.createElement("canvas");
      gridCanvas.width = canvas.width;
      gridCanvas.height = canvas.height;
      const g = gridCanvas.getContext("2d");
      if (g) {
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.translate(w / 2, h / 2);
        g.rotate((GRID_TILT * Math.PI) / 180);
        const R = Math.hypot(w, h) / 2 + 4;
        g.translate(-R, -R);
        drawGrid(g, R * 2, R * 2);
      }

      vignette = ctx.createRadialGradient(
        w / 2, h / 2, Math.min(w, h) * 0.35,
        w / 2, h / 2, Math.max(w, h) * 0.75,
      );
      vignette.addColorStop(0, "rgba(0,0,0,0)");
      vignette.addColorStop(1, "rgba(0,0,0,0.42)");

      headGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, 26);
      headGlow.addColorStop(0, `rgba(${GLOW},0.55)`);
      headGlow.addColorStop(1, `rgba(${GLOW},0)`);
    };

    // 节律器：以「上一搏起点 + 间距」规划下一搏；间距异常正是心律失常的来源
    const planBeat = (prevStart: number): Beat => {
      const rr = rrBase * rand(0.94, 1.06);
      let kind: BeatKind = "normal";
      let gap = rr;
      if (flatResumeBeat) {
        // 停搏后第一搏：更重、更响
        flatResumeBeat = false;
        return { start: prevStart + rr, rr, kind, amp: 1.45, fired: false };
      }
      if (compensatory) {
        compensatory = false;
        gap = rr * 1.55; // 室早后的代偿间歇
      } else if (tachyLeft > 0) {
        tachyLeft -= 1;
        gap = rr * 0.62;
      } else {
        const roll = Math.random();
        if (roll < 0.05) tachyLeft = 3 + Math.floor(Math.random() * 3);
        else if (roll < 0.11) {
          kind = "pvc";
          gap = rr * 0.55; // 提前搏动
          compensatory = true;
        } else if (roll < 0.18) {
          gap = rr * 2.05; // 漏搏：一整拍的沉默
        }
      }
      return { start: prevStart + gap, rr, kind, amp: rand(0.85, 1.15), fired: false };
    };

    const stepRhythm = (): void => {
      // 心率漂移：慢正弦 + 微噪声，让节律“活着”但不失规整
      rrBase = 0.92 + 0.08 * Math.sin(now * 0.05) + 0.02 * Math.sin(now * 0.31);
      const inFlat = now < flatUntil;
      while (now >= beat.start + beat.rr) {
        if (inFlat) {
          beat = { start: now, rr: 0.5, kind: "normal", amp: 0, fired: true };
        } else {
          // 间距以「上一搏起点」为基准（不是终点），否则每个间期都会多出一拍 rr
          beat = planBeat(beat.start);
        }
      }
      if (!inFlat && !beat.fired && now >= beat.start + beat.rr * R_PHASE) {
        beat.fired = true;
        flash = Math.min(1.4, 0.9 * beat.amp);
        // 三搏即封：第 RING_BEATS 損诞生时锁定收场时刻（含 lub-dub 尾圈散尽），
        // 之后搏动继续（心脏不停）但不再生圈，场景在完整周期上收束
        if (
          scene === "rings" &&
          ringsShown < RING_BEATS &&
          sceneT < sceneDur - FADE
        ) {
          const [cx, cy] = ringPlan[ringsShown] ?? RING_SPOTS[0];
          rings.push({ t0: now, strong: true, cx, cy });
          rings.push({ t0: now + 0.22, strong: false, cx, cy }); // lub-dub 第二心音
          ringsShown += 1;
          if (ringsShown >= RING_BEATS) sceneDur = sceneT + 0.22 + RING_LIFE;
        }
      }
      // 停搏惊吓：只在 ecg 场景、且不在淡出入边缘时触发
      if (scene === "ecg" && now > nextScare && sceneT > 2 && sceneT < sceneDur - 3.5) {
        flatUntil = now + rand(1.8, 2.6);
        nextScare = now + rand(45, 85);
        flatResumeBeat = true;
      }
    };

    // 写入迹线：头右移，途中的列写入采样，前方一小段抹除（监护仪扫描间隙）
    const writeTrace = (
      buf: TraceBuf,
      dt: number,
      cy: number,
      timeOffset: number,
      yOffset: number,
    ): void => {
      const speed = W * TRACE_SPEED;
      const ampPx = H * 0.14;
      const prev = buf.head;
      buf.head = (buf.head + speed * dt) % W;
      const from = Math.floor(prev);
      const to = Math.floor(buf.head);
      const cols = to >= from ? to - from : to + W - from;
      if (cols <= 0 || cols > W / 2) {
        if (cols > W / 2) buf.head = 0; // 异常跳变（如长暂停）直接复位
        if (cols <= 0) return;
      }
      const inFlat = now < flatUntil;
      for (let i = 0; i < cols; i++) {
        const x = (from + i) % W;
        const t = now - ((cols - i) * dt) / cols + timeOffset;
        const tb = beatFor(t);
        let v: number;
        if (inFlat || tb.amp === 0) {
          v = (hash(x * 3.1 + Math.floor(t * 90)) - 0.5) * 0.012; // 停搏：基线微噪
        } else {
          const p = (((t - tb.start) / tb.rr) % 1 + 1) % 1;
          v = ecgWave(p, tb.kind) * tb.amp;
          v += 0.03 * Math.sin(t * 0.9) + // 基线漂移
            (hash(x * 7.7 + Math.floor(t * 120)) - 0.5) * 0.02; // 肌电微噪
        }
        buf.y[x] = cy - v * ampPx + yOffset;
        buf.ts[x] = now;
      }
      // 抹除扫描头前方间隙
      const gap = 36;
      for (let i = 1; i <= gap; i++) {
        const x = (to + i) % W;
        buf.ts[x] = 0;
      }
    };

    // 查询任意历史时刻所属心跳（供回声轨用）；本实现只需近似：按 rrBase 回溯
    const beatFor = (t: number): Beat => {
      if (t >= beat.start) return beat;
      // 简化：历史时刻按当前 rrBase 回推，波形相位足够连续即可
      const back = Math.ceil((beat.start - t) / rrBase);
      const s = beat.start - back * rrBase;
      return { start: s, rr: rrBase, kind: "normal", amp: 1, fired: true };
    };

    // 段级闪烁：~26px 一段、~13Hz 硬切换，像接触不良的示波管
    const segVisible = (x: number): boolean => {
      const block = Math.floor(x / 26);
      const slot = Math.floor(now * 13);
      const p = now < burstUntil ? 0.34 : 0.1;
      return hash(block * 31.7 + slot * 7.3) > p;
    };

    const drawTrace = (buf: TraceBuf, alpha: number, echoMode: boolean): void => {
      if (alpha <= 0.01) return;
      const globalOn = now >= glitchUntil;
      const tau = 1.6; // 磷光余晖衰减常数
      const bins = 14;
      const paths: Path2D[] = [];
      const lastX = new Int32Array(bins).fill(-1);
      for (let i = 0; i < bins; i++) paths.push(new Path2D());
      const headX = Math.floor(buf.head);
      for (let x = 0; x < W; x++) {
        const ts = buf.ts[x];
        if (ts === 0) continue;
        const age = now - ts;
        let b = Math.exp(-age / tau);
        if (!echoMode) {
          if (!globalOn) b *= 0.04; // 全局硬切：近乎熄灭但留一丝残影
          if (!segVisible(x)) b *= 0.12; // 段级断线
          // 扫描头附近提亮（写入束）
          const dx = (headX - x + W) % W;
          if (dx < 26) b *= 1 + (1 - dx / 26) * (0.9 + flash * 1.4);
        }
        b *= alpha;
        if (b < 0.02) continue;
        const lvl = Math.min(bins - 1, Math.floor(b * bins));
        if (lastX[lvl] === x - 1) paths[lvl].lineTo(x, buf.y[x]);
        else paths[lvl].moveTo(x, buf.y[x]);
        lastX[lvl] = x;
      }
      // 三层描边：宽晕 / 中光 / 白热核心
      const passes: [number, number][] = echoMode
        ? [[4, 0.10], [1.4, 0.5]]
        : [[7, 0.05], [3, 0.16], [1.2, 0.85]];
      for (const [width, k] of passes) {
        ctx.lineWidth = width;
        ctx.lineJoin = "round";
        for (let i = 0; i < bins; i++) {
          const b = (i + 0.5) / bins;
          const a = b * k * (1 + flash * 0.5);
          if (a < 0.01) continue;
          ctx.strokeStyle = echoMode
            ? `rgba(${ECHO},${Math.min(1, a)})`
            : width < 2
              ? `rgba(253,243,216,${Math.min(1, a)})`
              : `rgba(${GLOW},${Math.min(1, a)})`;
          ctx.stroke(paths[i]);
        }
      }
      // 扫描头光点
      if (!echoMode && alpha > 0.05 && globalOn) {
        const hx = buf.head;
        const hy = buf.y[Math.floor(hx) % W] || H * 0.52;
        ctx.save();
        ctx.translate(hx, hy);
        ctx.globalAlpha = alpha * (0.5 + flash * 0.5);
        ctx.fillStyle = headGlow!;
        ctx.fillRect(-26, -26, 52, 52);
        ctx.fillStyle = CORE;
        ctx.beginPath();
        ctx.arc(0, 0, 1.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    };

    const drawRings = (alpha: number): void => {
      const maxR = Math.min(W, H) * 0.55;
      rings = rings.filter((r) => now - r.t0 < RING_LIFE);
      for (const r of rings) {
        const p = (now - r.t0) / RING_LIFE;
        const rad = Math.max(1, maxR * (1 - (1 - p) ** 2.2));
        const a = (1 - p) ** 2 * (r.strong ? 0.68 : 0.42) * alpha;
        if (a < 0.01) continue;
        ctx.lineWidth = r.strong ? 2 : 1.2;
        ctx.strokeStyle = `rgba(${GLOW},${a})`;
        ctx.beginPath();
        ctx.arc(r.cx * W, r.cy * H, rad, 0, Math.PI * 2);
        ctx.stroke();
      }
      // 核心：搏动的一小团光，落在最近一搏的落点上
      let coreX = W * 0.38;
      let coreY = H * 0.52;
      let newest = -1;
      for (const r of rings) {
        if (r.t0 > newest) {
          newest = r.t0;
          coreX = r.cx * W;
          coreY = r.cy * H;
        }
      }
      const core = (0.14 + flash * 0.55) * alpha;
      if (core > 0.01) {
        const grad = ctx.createRadialGradient(
          coreX, coreY, 0, coreX, coreY, 46 + flash * 30,
        );
        grad.addColorStop(0, `rgba(253,243,216,${Math.min(1, core)})`);
        grad.addColorStop(0.35, `rgba(${GLOW},${core * 0.5})`);
        grad.addColorStop(1, `rgba(${GLOW},0)`);
        ctx.fillStyle = grad;
        ctx.fillRect(coreX - 90, coreY - 90, 180, 180);
      }
    };

    const paint = (dt: number): void => {
      // 场景推进
      sceneT += dt;
      if (sceneT >= sceneDur) {
        // 淡出结束 → 黑场（黑场比场景本身更耐人寻味，刻意拉长）→ 下一场
        if (gapDur === 0) {
          gapDur = rand(3, 5.5);
          sceneT = sceneDur;
        }
        if (sceneT >= sceneDur + gapDur) {
          orderIdx = (orderIdx + 1) % order.length;
          scene = order[orderIdx];
          sceneT = 0;
          // 时长锚定完整周期：迹线场景 = 整两轮扫描；rings = 三搏（见下方提前收场判定）
          sceneDur = scene === "rings" ? 12 : TRACE_SWEEP * TRACE_SWEEPS + 0.15;
          gapDur = 0;
          main = makeTrace(W);
          echo = makeTrace(W);
          rings = [];
          ringsShown = 0;
          if (scene === "rings") {
            // 从候选落点里抽 RING_BEATS 个不重复的位置（Fisher-Yates 洗牌取前 N）
            const pool = RING_SPOTS.slice();
            for (let i = pool.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [pool[i], pool[j]] = [pool[j], pool[i]];
            }
            ringPlan = pool.slice(0, RING_BEATS);
          }
          if (scene === "ecg") {
            nextGlitch = now + rand(3.5, 8);
            nextBurst = now + rand(6, 13);
          }
        }
      }
      const inGap = gapDur > 0 && sceneT >= sceneDur;
      canvas.dataset.scene = inGap ? "gap" : scene; // 供 e2e/调试断言当前场景
      const sceneAlpha = inGap
        ? 0
        : sceneT < FADE
          ? smooth(Math.max(0, sceneT) / FADE)
          : sceneT > sceneDur - FADE
            ? smooth((sceneDur - sceneT) / FADE)
            : 1;

      stepRhythm();
      flash *= Math.exp(-dt / 0.16);

      // 闪烁事件调度
      if (scene === "ecg" || scene === "ghost") {
        if (now > nextGlitch && glitchUntil < now) {
          glitchUntil = now + rand(0.05, 0.28) * (Math.random() < 0.2 ? 3 : 1);
          nextGlitch = now + rand(4, 11);
        }
        if (now > nextBurst) {
          burstUntil = now + rand(0.5, 1.2);
          nextBurst = now + rand(7, 15);
        }
      }
      if (scene === "ghost") {
        // 回声延迟漂移：两颗心渐渐失同步
        echoDelay = 0.16 + 0.3 * (0.5 + 0.5 * Math.sin(now * 0.11));
      }

      const cy = H * 0.52;
      if (!inGap && (scene === "ecg" || scene === "ghost") && sceneAlpha > 0) {
        writeTrace(main, dt, cy, 0, 0);
        if (scene === "ghost") writeTrace(echo, dt, cy, -echoDelay, H * 0.012);
      }

      // ---- 合成 ----
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, W, H);
      if (gridCanvas) ctx.drawImage(gridCanvas, 0, 0, W, H);

      if (scene === "ecg" || scene === "ghost") {
        if (scene === "ghost") drawTrace(echo, sceneAlpha * 0.55, true);
        drawTrace(main, sceneAlpha, false);
      } else if (scene === "rings") {
        drawRings(sceneAlpha);
      }

      // R 峰微光脉冲：以迹线高度为中心的一次呼吸式提亮
      if (flash > 0.02 && !inGap) {
        const fy = scene === "rings" ? H * 0.52 : cy;
        const fg = ctx.createRadialGradient(W * 0.4, fy, 0, W * 0.4, fy, W * 0.45);
        fg.addColorStop(0, `rgba(${GLOW},${0.10 * Math.min(1, flash)})`);
        fg.addColorStop(1, `rgba(${GLOW},0)`);
        ctx.fillStyle = fg;
        ctx.fillRect(0, 0, W, H);
      }

      // 常驻暗角；黑场间歇里带一点缓慢的呼吸，免得页面彻底死掉
      if (vignette) {
        ctx.fillStyle = vignette;
        ctx.fillRect(0, 0, W, H);
      }
      if (inGap) {
        const breathe = 0.07 + 0.045 * Math.sin(now * 1.4);
        const bg2 = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, H * 0.5);
        bg2.addColorStop(0, `rgba(${GLOW},${breathe})`);
        bg2.addColorStop(1, `rgba(${GLOW},0)`);
        ctx.fillStyle = bg2;
        ctx.fillRect(0, 0, W, H);
      }
    };

    const paintStatic = (): void => {
      // reduced-motion：一帧静态写实心电，不闪烁不轮换
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, W, H);
      if (gridCanvas) ctx.drawImage(gridCanvas, 0, 0, W, H);
      const cy = H * 0.52;
      const ampPx = H * 0.14;
      const rrPx = W / 3.5;
      ctx.lineJoin = "round";
      const path = new Path2D();
      for (let x = 0; x < W; x++) {
        const p = (x % rrPx) / rrPx;
        const y = cy - ecgWave(p, "normal") * ampPx;
        if (x === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      ctx.lineWidth = 3;
      ctx.strokeStyle = `rgba(${GLOW},0.16)`;
      ctx.stroke(path);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = "rgba(253,243,216,0.85)";
      ctx.stroke(path);
      if (vignette) {
        ctx.fillStyle = vignette;
        ctx.fillRect(0, 0, W, H);
      }
    };

    const tick = (ts: number): void => {
      raf = 0;
      if (disposed || document.hidden || !visible) {
        last = 0;
        return;
      }
      const delta = last ? Math.min((ts - last) / 1000, 0.05) : 1 / 60;
      last = ts;
      if (!reduced.matches) {
        now += delta;
        paint(delta);
        raf = requestAnimationFrame(tick);
      } else {
        paintStatic();
      }
    };
    const schedule = (): void => {
      if (!raf && !disposed && !document.hidden) raf = requestAnimationFrame(tick);
    };
    const onVis = (): void => {
      last = 0;
      schedule();
    };
    const onMotion = (): void => {
      last = 0;
      if (reduced.matches) paintStatic();
      schedule();
    };

    const io = new IntersectionObserver(
      ([e]) => {
        visible = e.isIntersecting;
        last = 0;
        schedule();
      },
      { threshold: 0.05 },
    );
    io.observe(canvas);
    const ro = new ResizeObserver(() => {
      resize();
      if (reduced.matches) paintStatic();
      schedule();
    });
    ro.observe(canvas);

    document.addEventListener("visibilitychange", onVis);
    reduced.addEventListener("change", onMotion);

    resize();
    schedule();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      reduced.removeEventListener("change", onMotion);
    };
  }, []);

  return <canvas ref={ref} className="ecg-canvas" aria-hidden="true" />;
}
