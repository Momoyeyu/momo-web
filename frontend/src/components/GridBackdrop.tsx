// 设置页网格背景：与标题页同一把标尺（lib/grid），但按 tab 坐标系整体旋转。
//   - 每个 tab 拥有自己的正交坐标系 θ_k = k · Δ（RoPE 式：位置 → 旋转角），
//     只做旋转矩阵变换，无缩放/剪切；
//   - 切换 tab 时从当前角加速-减速地转到目标角（easeInOutCubic，时长与
//     tab 高亮滑块、内容横滑严格一致，三件事是一次统一的"坐标系变换"）；
//   - 角度单调映射 tab 下标：向右切 → 顺时针，向左切 → 逆时针（画布 y 轴
//     向下，rotate 正角即顺时针，天然成立）；
//   - 动画途中再次切换：从当前插值角续接，不跳变；
//   - prefers-reduced-motion：直接落位；页面隐藏/离屏时不空转。
// 纯 Canvas 2D，切 tab 才起 rAF，静止时零开销。

import { useEffect, useRef } from "react";
import { drawGrid } from "../lib/grid";

const BG = "#16121a"; // var(--bg)
const SWEEP_MS = 350; // 与 .stab-thumb/.settings-track 的 CSS 过渡时长一致

const easeInOutCubic = (p: number): number =>
  p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;

export interface GridBackdropApi {
  rotate: (deg: number) => void; // 缓动转到目标角（tab/翻页切换）
  seek: (deg: number) => void; // 瞬时落位（挂载首次、reduced-motion）
  setAngle: (deg: number) => void; // 拖拽跟手：逐帧直设，不缓动
}

export default function GridBackdrop({
  angle,
  contrast = 1,
  api,
}: {
  angle: number;
  /** 网格对比度倍数（面板遮住大半画面时，边缘网格可以更实一点） */
  contrast?: number;
  /** 供拖拽跟手/手动吸附用的命令通道（可选） */
  api?: React.MutableRefObject<GridBackdropApi | null>;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const apiRef = useRef<GridBackdropApi | null>(null);

  // 挂载一次：canvas、绘制与 rAF 动画机；对外的控制面存进 apiRef
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let W = 0;
    let H = 0;
    let dpr = 1;
    let raf = 0;
    let disposed = false;
    let cur = 0; // 当前显示角（度）
    let from = 0;
    let to = 0;
    let t0 = 0;
    let vignette: CanvasGradient | null = null;

    const draw = (deg: number): void => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.rotate((deg * Math.PI) / 180);
      // 旋转覆盖范围按对角线半径扩，任意角度都铺满画面
      const R = Math.hypot(W, H) / 2 + 4;
      ctx.translate(-R, -R);
      drawGrid(ctx, R * 2, R * 2, contrast);
      ctx.restore();
      if (vignette) {
        ctx.fillStyle = vignette;
        ctx.fillRect(0, 0, W, H);
      }
    };

    const loop = (ts: number): void => {
      raf = 0;
      if (disposed || document.hidden) return;
      const p = Math.min(1, (ts - t0) / SWEEP_MS);
      cur = from + (to - from) * easeInOutCubic(p);
      draw(cur);
      if (p < 1) raf = requestAnimationFrame(loop);
    };

    const rotate = (deg: number): void => {
      if (deg === to && cur === to) {
        return;
      }
      if (reduced.matches) {
        seek(deg);
        return;
      }
      from = cur; // 从当前插值角续接，中途切换不跳变
      to = deg;
      t0 = performance.now();
      if (!raf) raf = requestAnimationFrame(loop);
    };

    const seek = (deg: number): void => {
      cur = from = to = deg;
      draw(cur);
    };

    const setAngle = (deg: number): void => {
      // 拖拽跟手：直接落角（from/to 同步，随后的 rotate 从这里续接）
      cur = from = to = deg;
      draw(cur);
    };

    const resize = (): void => {
      dpr = Math.min(devicePixelRatio || 1, 2);
      W = canvas.clientWidth;
      H = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      vignette = ctx.createRadialGradient(
        W / 2, H / 2, Math.min(W, H) * 0.35,
        W / 2, H / 2, Math.max(W, H) * 0.75,
      );
      vignette.addColorStop(0, "rgba(0,0,0,0)");
      vignette.addColorStop(1, "rgba(0,0,0,0.30)");
      draw(cur);
    };

    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas);
    const onVis = (): void => {
      // 回到前台时若动画没走完，从当前角以完整时长续播（隐藏期间 rAF 冻结）
      if (!document.hidden && cur !== to) {
        from = cur;
        t0 = performance.now();
        if (!raf) raf = requestAnimationFrame(loop);
      }
    };
    document.addEventListener("visibilitychange", onVis);

    resize();
    apiRef.current = { rotate, seek, setAngle };
    if (api) api.current = apiRef.current;

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      apiRef.current = null;
      if (api) api.current = null;
    };
  }, []);

  // angle 变化 → 首次直接落位，之后缓动转到新坐标系
  const firstRef = useRef(true);
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      apiRef.current?.seek(angle);
    } else {
      apiRef.current?.rotate(angle);
    }
  }, [angle]);

  return <canvas ref={ref} className="grid-backdrop" aria-hidden="true" />;
}
