// pixi 舞台 + pixi-live2d-display（Cubism 4）模型加载。
// pixi 锁 v7 = pixi-live2d-display@0.5.0-beta peer 范围；约定从全局读 PIXI。
// Cubism Core 从官方 CDN 注入 <script>（可 VITE_MOMO_CUBISM_CORE_URL 覆盖）。
// 参考 momo/app/web/src/live2d/stage.ts 但简化：安全区即全窗口，底边贴
// 底部对话框区（CSS 变量 --dialog-zone-h）。

import * as PIXI from "pixi.js";
import type { EmotionTag } from "../lib/types";
import { AVATAR_BUILTIN, getAvatarId, getAvatars } from "../lib/store";
import { getBlob } from "../lib/idb";
import { EMOTION_MOTIONS } from "./emotions";
import { makeAvatarSource, wireZipLoader } from "./avatarZip";

// pixi-live2d-display 约定从全局读 PIXI（仅浏览器环境注入）。
if (typeof window !== "undefined") {
  (window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;
}

const DEFAULT_CORE_URL =
  "https://cubism.live2d.com/sdk-web/core/05/live2dcubismcore.min.js";
const DEFAULT_AVATAR_URL = "/live2d/hiyori/Hiyori.model3.json";
const CORE_TIMEOUT_MS = 15000;
const FALLBACK_DIALOG_ZONE_H = 140;
/** 模型高度占可用高度（窗口高 - 对话框区）的比例。 */
const MODEL_HEIGHT_FRAC = 0.85;
/** 右侧留给面板/菜单：模型水平中心落在窗口宽度的偏左位置。 */
const MODEL_CENTER_X_FRAC = 0.44;

let corePromise: Promise<void> | null = null;

/** Cubism Core script url（VITE_MOMO_CUBISM_CORE_URL 可换自建镜像）。 */
function cubismCoreUrl(): string {
  const v = import.meta.env.VITE_MOMO_CUBISM_CORE_URL;
  return typeof v === "string" && v.trim() ? v : DEFAULT_CORE_URL;
}

/** 注入 live2dcubismcore.min.js：幂等、15s 超时、失败重置可重试。 */
function ensureCubismCore(): Promise<void> {
  const g = window as unknown as { Live2DCubismCore?: unknown };
  if (g.Live2DCubismCore) return Promise.resolve();
  corePromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    const timer = window.setTimeout(() => {
      script.remove();
      corePromise = null;
      reject(new Error("Cubism Core load timed out"));
    }, CORE_TIMEOUT_MS);
    const fail = (why: string) => {
      window.clearTimeout(timer);
      script.remove();
      corePromise = null;
      reject(new Error(why));
    };
    script.addEventListener(
      "load",
      () => {
        if (!g.Live2DCubismCore) {
          fail("Cubism Core loaded but Live2DCubismCore is missing");
          return;
        }
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    script.addEventListener("error", () => fail("Cubism Core script failed to load"), {
      once: true,
    });
    script.src = cubismCoreUrl();
    script.crossOrigin = "anonymous";
    document.head.appendChild(script);
  });
  return corePromise;
}

/** 读取 :root 上的数值 CSS 变量（解析失败按 fallback）。 */
function readCssNum(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  const v = Number.parseFloat(raw);
  return Number.isFinite(v) ? v : fallback;
}

interface ModelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class Live2DStage {
  private app: PIXI.Application | null = null;
  // pixi-live2d-display 类型与其打包的 pixi 版本耦合，按 any 处理。
  private model: any = null;
  private bounds: ModelBounds | null = null;
  /** 加载中的 promise（去重并发/StrictMode 重复调用）。 */
  private loading: Promise<void> | null = null;
  private modelUrl: string | null = null;
  /** 当前模型是否内置 Hiyori（情绪映射表只对它有效）。 */
  private builtin = true;

  /** 模型是否已加载（口型/情绪写参前置检查）。 */
  get ready(): boolean {
    return this.model != null;
  }

  /** 初始化舞台（透明背景叠页面；canvas 全窗口）。幂等：同一 canvas 重复调用跳过。 */
  init(canvas: HTMLCanvasElement): void {
    if (this.app) {
      if ((this.app.view as HTMLCanvasElement) === canvas) return;
      // 换 canvas（真实重挂载）：旧 app 销毁重建。
      this.dispose();
    }
    this.app = new PIXI.Application({
      view: canvas,
      resizeTo: window,
      backgroundAlpha: 0,
      antialias: true,
      // Retina 清晰度：backbuffer 按 dpr 放大，CSS 尺寸保持逻辑像素——
      // 否则高分屏 1x 渲染再放大显示，立绘明显发糊。
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    this.app.renderer.on("resize", () => this.fitModel());
    // 路由切换会改变 --dialog-zone-h（chat 页才有对话区）→ 重新落位。
    window.addEventListener("hashchange", this.refit);
  }

  private readonly refit = (): void => this.fitModel();

  /** 加载模型（默认 /live2d/hiyori/Hiyori.model3.json）。幂等去重；失败 reject 由调用方降级。 */
  async loadModel(url: string): Promise<void> {
    if (!this.app) throw new Error("stage not initialized");
    if (this.model && this.modelUrl === url) return;
    if (this.loading) return this.loading;
    this.loading = this.doLoad(() => url, url, true).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /**
   * 按当前设置加载形象：内置 → URL；导入模型 → IndexedDB zip →
   * Live2DModel.from([File])（库内 ZipLoader+FileLoader 解包映射）。
   * 导入模型加载失败 → 静默回退内置 Hiyori，不阻断聊天。
   */
  async loadAvatar(): Promise<void> {
    if (!this.app) return;
    const id = getAvatarId();
    if (id === AVATAR_BUILTIN) {
      await this.loadModel(avatarModelUrl());
      return;
    }
    const meta = getAvatars().find((a) => a.id === id);
    const blob = meta ? await getBlob(id) : null;
    if (!meta || !blob) {
      await this.loadModel(avatarModelUrl());
      return;
    }
    const key = `avatar:${id}`;
    if (this.model && this.modelUrl === key) return;
    if (this.loading) return this.loading;
    this.loading = this.doLoad(
      async (mod) => makeAvatarSource(mod, blob, meta),
      key,
      false,
    )
      .catch(() => this.doLoad(() => avatarModelUrl(), avatarModelUrl(), true))
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  private async doLoad(
    makeSource: (mod: any) => unknown | Promise<unknown>,
    key: string,
    isBuiltin: boolean,
  ): Promise<void> {
    await ensureCubismCore();
    const mod: any = await import("pixi-live2d-display/cubism4");
    mod.config.sound = false;
    wireZipLoader(mod);
    const source = await makeSource(mod);
    const model = await mod.Live2DModel.from(source);
    if (this.model) {
      this.app?.stage.removeChild(this.model);
      this.model.destroy?.();
      this.model = null;
    }
    this.model = model;
    this.modelUrl = key;
    this.builtin = isBuiltin;
    const b = model.getLocalBounds();
    this.bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    this.app?.stage.addChild(model);
    this.fitModel();
  }

  /** 模型缩放/落位：高≈可用高度的 85%，底边贴对话框区上沿，
   * 水平居中偏左（右侧留给面板/菜单）。 */
  private fitModel(): void {
    if (!this.app || !this.model || !this.bounds) return;
    const { screen } = this.app.renderer;
    const dialogH = readCssNum("--dialog-zone-h", FALLBACK_DIALOG_ZONE_H);
    const availH = Math.max(0, screen.height - dialogH);
    const b = this.bounds;
    if (b.width <= 0 || b.height <= 0 || availH <= 0) return;
    const scale = (availH * MODEL_HEIGHT_FRAC) / b.height;
    this.model.scale.set(scale);
    this.model.y = availH - (b.y + b.height) * scale;
    const cx = screen.width * MODEL_CENTER_X_FRAC;
    this.model.x = cx - (b.x + b.width / 2) * scale;
  }

  /** 口型 0..1 → ParamMouthOpenY。 */
  setMouthOpen(v: number): void {
    const core = this.model?.internalModel?.coreModel;
    if (!core || typeof core.setParameterValueById !== "function") return;
    const clamped = Math.min(1, Math.max(0, v));
    core.setParameterValueById("ParamMouthOpenY", clamped);
  }

  /** 情绪 → 动作：内置模型走 EMOTION_MOTIONS 映射表；导入模型按
   * 约定组名（motion group 名 == tag 名）尝试，缺失静默交给 Idle。 */
  playEmotion(tag: EmotionTag): void {
    if (!this.model) return;
    try {
      if (this.builtin) {
        const spec = EMOTION_MOTIONS[tag];
        if (!spec) return; // neutral / 未映射：交给 Idle 自动轮播
        this.model.motion(spec.group, spec.index)?.catch?.(() => {});
      } else {
        this.model.motion(tag)?.catch?.(() => {});
      }
    } catch {
      // 动作资源缺失等：静默
    }
  }

  dispose(): void {
    window.removeEventListener("hashchange", this.refit);
    this.loading = null;
    this.model = null;
    this.bounds = null;
    this.modelUrl = null;
    if (this.app) {
      // removeView=false：canvas 归 React 管，不从 DOM 移除。
      this.app.destroy(false, { children: true });
      this.app = null;
    }
  }
}

let stage: Live2DStage | null = null;

/** 全局舞台单例（Title 与 Chat 共享同一形象）。 */
export function getStage(): Live2DStage {
  stage ??= new Live2DStage();
  return stage;
}

/** 模型 url：默认 vendored Hiyori；VITE_MOMO_AVATAR_URL 可覆盖。 */
function avatarModelUrl(): string {
  const v = import.meta.env.VITE_MOMO_AVATAR_URL;
  return typeof v === "string" && v.trim() ? v : DEFAULT_AVATAR_URL;
}
