import { SpeechMouth } from "./speechMouth";
import { motionPlayback, type MotionPlaybackEntry, type PreviewPlayback } from "./previewPlayback";
// pixi 舞台 + pixi-live2d-display（Cubism 4）模型加载。
// pixi 锁 v7 = pixi-live2d-display@0.5.0-beta peer 范围；约定从全局读 PIXI。
// Cubism Core 从官方 CDN 注入 <script>（可 VITE_MOMO_CUBISM_CORE_URL 覆盖）。
// 参考 momo/app/web/src/live2d/stage.ts 但简化：安全区即全窗口，底边贴
// 底部对话框区（CSS 变量 --dialog-zone-h）。

import { ensureIdleGroup, parseExpression, reconcileResources, type ResourceCatalog, type RuntimeResource } from "./controlCatalog";
import { ParameterMixer } from "./parameterMixer";
import { PerformanceController } from "./performanceController";
import type { PerformanceCue, PresentationSnapshot } from "./performanceTypes";
import * as PIXI from "pixi.js";
import { getAvatarId, getAvatars } from "../lib/store";
import { getBlob } from "../lib/idb";
import { makeAvatarSource, wireZipLoader } from "./avatarZip";

// pixi-live2d-display 约定从全局读 PIXI（仅浏览器环境注入）。
if (typeof window !== "undefined") {
  (window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;
}

const DEFAULT_CORE_URL =
  "/api/live2d/core";
const DEFAULT_AVATAR_URL = "/live2d/hiyori/Hiyori.model3.json";
const CORE_TIMEOUT_MS = 30000;
const FALLBACK_DIALOG_ZONE_H = 140;
/** 模型高度占可用高度（窗口高 - 对话框区）的比例。 */
const MODEL_HEIGHT_FRAC = 0.85;
/** 右侧留给面板/菜单：模型水平中心落在窗口宽度的偏左位置。 */
const MODEL_CENTER_X_FRAC = 0.5;

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
  private epoch = 0;
  private actualAvatarId = "builtin";
  private controller: PerformanceController | null = null;
  private catalog: ResourceCatalog | null = null;
  private neutralPose: Map<string, number> | null = null;
  private speechMouth = new SpeechMouth();
  private previewMode: "raw" | "composed" = "raw";
  private closeUp = true;
  private blinkAt = 0;
  private tapTimer: ReturnType<typeof setTimeout> | undefined;
  private requestedAvatar = "";
  private chatHost: HTMLElement | null = null;
  private chatVisible = false;
  private previewHost: HTMLElement | null = null;
  private previewAvatarId: string | null = null;
  private previewLease = 0;
  private chatCloseUp = true;
  private viewportObserver: ResizeObserver | null = null;
  private previewPlayback: { status: PreviewPlayback; entry?: MotionPlaybackEntry; expressionStarted?: number } | null = null;
  private previewChannel: "expressions" | "motions" | null = null;

  // pixi-live2d-display 类型与其打包的 pixi 版本耦合，按 any 处理。
  private model: any = null;
  private bounds: ModelBounds | null = null;
  /** 加载中的 promise（去重并发/StrictMode 重复调用）。 */
  private loading: Promise<void> | null = null;

  /** 模型是否已加载（口型/情绪写参前置检查）。 */
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
  }

  /** One canvas/context/ticker; only its host and viewport change. */
  setChatHost(host: HTMLElement): void {
    this.chatHost = host;
    if (!this.previewHost) this.attachViewport(host);
  }
  setChatVisible(visible: boolean): void {
    this.chatVisible = visible;
    if (!this.app) return;
    const canvas = this.app.view as HTMLCanvasElement;
    canvas.style.opacity = visible || this.previewHost ? "1" : "0";
    canvas.style.pointerEvents = visible && !this.previewHost ? "auto" : "none";
  }
  private attachViewport(host: HTMLElement): void {
    if (!this.app) return;
    const canvas = this.app.view as HTMLCanvasElement;
    host.appendChild(canvas);
    this.viewportObserver?.disconnect();
    this.app.resizeTo = host;
    const resize = () => { this.app?.resize(); this.fitModel(); };
    this.viewportObserver = new ResizeObserver(resize);
    this.viewportObserver.observe(host);
    resize();
    this.setChatVisible(this.chatVisible);
  }
  openResourcePreview(host: HTMLElement, avatarId: string): { ready: Promise<void>; release: () => void } {
    const lease = ++this.previewLease;
    if (!this.previewHost) this.chatCloseUp = this.closeUp;
    this.previewHost = host;
    this.previewAvatarId = avatarId;
    this.previewMode = "raw";
    this.previewChannel = null;
    this.previewPlayback = null;
    this.closeUp = true;
    clearTimeout(this.tapTimer);
    this.controller?.previewExpression(null);
    this.model?.internalModel?.motionManager.stopAllMotions();
    this.restoreNeutralPose();
    this.attachViewport(host);
    const ready = this.app ? this.loadAvatar(avatarId).then(() => {
      if (lease !== this.previewLease) return;
      if (this.actualAvatarId !== avatarId) throw new Error("Preview model unavailable");
      this.controller?.beginPreview();
      this.fitModel();
    }) : Promise.reject(new Error("Renderer unavailable"));
    return { ready, release: () => {
      if (lease !== this.previewLease) return;
      this.previewLease++;
      this.endPreview();
      this.previewHost = null;
      this.previewAvatarId = null;
      this.previewChannel = null;
      this.closeUp = this.chatCloseUp;
      if (this.chatHost) this.attachViewport(this.chatHost);
      void this.loadAvatar().catch(error => console.warn("Restore avatar:", error));
    } };
  }

  /** 加载模型（默认 /live2d/hiyori/Hiyori.model3.json）。幂等去重；失败 reject 由调用方降级。 */
  async loadModel(url: string): Promise<void> {
    const epoch = ++this.epoch;
    this.cancelPerformance(); this.catalog = null;
    await this.doLoad(() => url, url, epoch, "builtin");
  }

  async loadAvatar(id = this.previewAvatarId ?? getAvatarId()): Promise<void> {
    if (!this.app) return;
    if (this.loading && this.requestedAvatar === id) return this.loading;
    if (this.catalog && this.requestedAvatar === id) return;
    this.requestedAvatar = id;
    const epoch = ++this.epoch;
    this.cancelPerformance(); this.catalog = null;
    const meta = getAvatars().find((a) => a.id === id);
    this.loading = (async () => {
      if (!meta || meta.builtin) return this.doLoad(() => avatarModelUrl(), avatarModelUrl(), epoch, "builtin");
      try {
        const blob = await getBlob(id);
        if (!blob) throw new Error("Avatar archive missing");
        await this.doLoad((mod) => makeAvatarSource(mod, blob, meta), `avatar:${id}`, epoch, id);
      } catch (error) {
        if (epoch !== this.epoch) return;
        console.warn("Avatar fallback:", error);
        await this.doLoad(() => avatarModelUrl(), avatarModelUrl(), epoch, "builtin");
      }
    })().finally(() => { if (epoch === this.epoch) this.loading = null; });
    return this.loading;
  }

  private async doLoad(
    makeSource: (mod: any) => unknown | Promise<unknown>,
    _key: string,
    epoch: number,
    avatarId: string,
  ): Promise<void> {
    await ensureCubismCore();
    const mod: any = await import("pixi-live2d-display/cubism4");
    mod.config.sound = false;
    wireZipLoader(mod);
    const source = await makeSource(mod);
    const model = await mod.Live2DModel.from(source, { idleMotionGroup: "MomoIdle" });
    if (epoch !== this.epoch || !this.app) { model.destroy(); return; }
    await this.configurePerformance(model, epoch, avatarId);
    if (epoch !== this.epoch || !this.app) { model.destroy(); return; }
    if (this.model) {
      this.app?.stage.removeChild(this.model);
      this.model.destroy?.();
      this.model = null;
    }
    this.model = model;
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
    const dialogH = this.previewHost ? 0 : readCssNum("--dialog-zone-h", FALLBACK_DIALOG_ZONE_H);
    const availH = Math.max(0, screen.height - dialogH);
    const b = this.bounds;
    if (b.width <= 0 || b.height <= 0 || availH <= 0) return;
    const scale = (availH * MODEL_HEIGHT_FRAC * (this.closeUp ? 1.8 : 1)) / b.height;
    this.model.scale.set(scale);
    this.model.y = availH - (b.y + b.height * (this.closeUp ? 0.6 : 1)) * scale;
    const cx = screen.width * MODEL_CENTER_X_FRAC;
    this.model.x = cx - (b.x + b.width / 2) * scale;
  }

  setCloseUp(value: boolean): void { this.closeUp = value; this.fitModel(); }
  getCloseUp(): boolean { return this.closeUp; }

  /** All mouth writes occur in the same frame hook as expressions and blinking. */
  setMouthOpen(v: number, active = v > 0): void { this.speechMouth.set(v, active, performance.now()); }

  private async configurePerformance(model: any, epoch: number, avatarId: string): Promise<void> {
    const internal = model.internalModel;
    const core = internal.coreModel;
    const params = core.getModel().parameters;
    const ids = new Set<string>(Array.from(params.ids));
    const definitions = (await Promise.all((internal.settings.expressions ?? []).map(async (entry: { Name: string; File: string }) => {
      try {
        const response = await fetch(internal.settings.resolveURL(entry.File));
        if (!response.ok) throw new Error("Expression resource unavailable");
        return parseExpression(entry.Name, await response.json(), ids);
      } catch (error) { console.warn("Expression disabled:", entry.Name, error); return null; }
    }))).filter((x): x is NonNullable<typeof x> => x !== null);
    const motions: RuntimeResource[] = [];
    const groups = internal.settings.motions ?? {};
    // Imported models get a neutral, single-resource idle group; no full random emotion group.
    ensureIdleGroup(groups, internal.motionManager.motionGroups, avatarId === "builtin" ? "motions/Hiyori_m01.motion3.json" : undefined);
    await Promise.all(Object.entries(groups).filter(([g]) => g !== "MomoIdle").flatMap(([group, entries]) =>
      (entries as unknown[]).map(async (_, index) => {
        try {
          const motion = await internal.motionManager.loadMotion(group, index);
          if (!motion) return;
          const fileName = (entries as { File: string }[])[index].File;
          const alias = `${group}/${index}`;
          const existing = motions.find(m => m.name === fileName);
          if (existing) existing.aliases.push(alias);
          else motions.push({ name: fileName, fileName, group, index, aliases: [alias],
            duration: (() => { const d = motion.getDuration() > 0 ? motion.getDuration() : motion.getLoopDuration(); return Number.isFinite(d) && d > 0 && d <= 3600 ? d : undefined; })(),
            parameterIds: (motion._motionData?.curves ?? []).filter((c: any) => c.type === 1).map((c: any) => c.id) });
        }
        catch (error) { console.warn("Motion disabled:", group, index, error); }
      })));
    if (epoch !== this.epoch) return;
    // Hiyori's authored neutral arms differ from moc default values. Reset to
    // its verified idle's first frame; imported models keep their own defaults.
    this.neutralPose = null;
    if (avatarId === "builtin") {
      const neutral = motions.find(m => m.name === "motions/Hiyori_m01.motion3.json");
      const data = neutral ? internal.motionManager.motionGroups[neutral.group!][neutral.index!]?._motionData : null;
      if (data) this.neutralPose = new Map(data.curves.filter((c: any) => c.type === 1 && ids.has(c.id)).map((c: any) =>
        [c.id, data.points[data.segments[c.baseSegmentIndex].basePointIndex].value]));
    }
    const mixer = new ParameterMixer();
    const controller = new PerformanceController(definitions, mixer, async (id) => {
      if (epoch !== this.epoch || this.model !== model) return false;
      const resource = motions.find(m => m.name === id || m.aliases.includes(id));
      if (!resource) return false;
      const playback = this.previewHost && this.previewChannel === "motions" ? this.previewPlayback : null;
      try {
        const played = await model.motion(resource.group, resource.index, 3);
        if (playback && playback === this.previewPlayback && epoch === this.epoch) {
          // Keep the entry after the SDK removes it from its queue on completion.
          playback.entry = played ? internal.motionManager.queueManager._motions.at(-1) : undefined;
          playback.status = { phase: played && playback.entry ? "playing" : "failed", progress: 0 };
        }
        return played;
      } catch (error) {
        if (playback === this.previewPlayback && playback) playback.status = { phase: "failed", progress: 0 };
        throw error;
      }
    });
    internal.motionManager.expressionManager = undefined;
    internal.eyeBlink = undefined;
    this.controller = controller;
    if (this.previewHost) controller.beginPreview();
    this.actualAvatarId = avatarId;
    this.catalog = {
      expressions: definitions.map(d => ({ name: d.name,
        fileName: internal.settings.expressions.find((e: any) => e.Name === d.name).File,
        aliases: [], parameterIds: d.parameters.map((p: { id: string }) => p.id) })),
      motions: motions.sort((a,b) => a.name.localeCompare(b.name)),
    };
    const state = internal.motionManager.state;
    const requestIdle = state.shouldRequestIdleMotion;
    state.shouldRequestIdleMotion = () => !this.previewHost && requestIdle.call(state);
    const eyes = (internal.settings.getEyeBlinkParameters?.() ?? []).filter((id: string) => ids.has(id));
    const eyeIds = eyes.length ? eyes : ["ParamEyeLOpen", "ParamEyeROpen"].filter((id) => ids.has(id));
    this.blinkAt = performance.now() + 3000;
    internal.on("beforeModelUpdate", () => {
      if (epoch !== this.epoch) return;
      const now = performance.now();
      const elapsed = now - this.blinkAt;
      let blink = 1;
      if (elapsed >= 0 && elapsed <= 180) blink = Math.abs(elapsed - 90) / 90;
      else if (elapsed > 180) this.blinkAt = now + 2800 + Math.random() * 2500;
      const raw = this.previewHost && this.previewMode === "raw";
      const motion = this.catalog?.motions.find(m => m.aliases.includes(`${state.currentGroup}/${state.currentIndex}`));
      // Authored eye animation owns its parameters; procedural blinks only fill gaps.
      const blinkEyes = raw ? [] : eyeIds.filter((id: string) => !motion?.parameterIds.includes(id));
      const mouth = this.previewHost ? { value: 0, weight: 0 } : this.speechMouth.sample(now);
      if (!(raw && this.previewChannel === "motions")) {
        mixer.apply(core, now, { eyes: blinkEyes, blink, mouthId: ids.has("ParamMouthOpenY") ? "ParamMouthOpenY" : undefined,
          mouth: mouth.value, mouthWeight: mouth.weight });
      }
      for (let i = 0; i < params.count; i++) {
        const value = core.getParameterValueById(params.ids[i]);
        core.setParameterValueById(params.ids[i], Math.max(params.minimumValues[i], Math.min(params.maximumValues[i], value)));
      }
    });
  }

  getPresentation(includeDisabled = false): PresentationSnapshot | null {
    if (!this.catalog || !this.controller) return null;
    const resources = getAvatars().find((a) => a.id === this.actualAvatarId)?.resources;
    const merged = reconcileResources(this.catalog, resources);
    const entries = (kind: "expressions" | "motions") => merged[kind]
      .filter(r => includeDisabled || r.enabled !== false)
      .map(r => ({ name: r.name, desc: r.desc, label: r.label, context: r.context,
        ...(kind === "motions" ? { duration: this.catalog!.motions.find(m => m.name === r.name)?.duration } : {}) }));
    const expressions = entries("expressions");
    const state = this.controller.state;
    return { avatarId: this.actualAvatarId, revision: String(this.epoch), expressions, motions: entries("motions"),
      expressionState: expressions.some((e) => e.name === state.name) ? { ...state } : { name: null, intensity: 0 } };
  }
  getResourceCatalog(): ResourceCatalog | null { return this.catalog; }
  setPreviewMode(mode: "raw" | "composed"): void { this.previewMode = mode; }
  beginPerformance(turnId: string): void { this.controller?.beginTurn(turnId); }
  endPerformance(turnId: string): void { this.controller?.endTurn(turnId); }
  applyCue(cue: PerformanceCue, turnId: string, revision: string): void {
    const snapshot = this.getPresentation();
    if (!snapshot || snapshot.revision !== revision) { this.controller?.record(cue.id, "stale-model"); return; }
    const next = { ...cue };
    if (next.expression && !snapshot.expressions.some((e) => e.name === next.expression!.name)) { this.controller?.record(cue.id, "expression-unavailable"); delete next.expression; }
    if (next.motion && !snapshot.motions.some((m) => m.name === next.motion)) { this.controller?.record(cue.id, "motion-unavailable"); delete next.motion; }
    if (!("expression" in next) && !next.motion) return;
    this.controller?.apply(next, turnId);
  }
  private restoreNeutralPose(): void {
    const core = this.model?.internalModel?.coreModel;
    if (!core) return;
    const parameters = core.getModel().parameters;
    for (let i = 0; i < parameters.count; i++) core.setParameterValueById(parameters.ids[i], this.neutralPose?.get(parameters.ids[i]) ?? parameters.defaultValues[i]);
    core.saveParameters();
  }
  previewExpression(name: string | null): void {
    clearTimeout(this.tapTimer);
    if (this.previewHost) { this.previewPlayback = name ? { status: { phase: "playing", progress: 0 }, expressionStarted: performance.now() } : null; this.previewChannel = "expressions"; this.model?.internalModel?.motionManager.stopAllMotions(); this.restoreNeutralPose(); }
    this.controller?.previewExpression(name);
  }
  previewMotion(id: string): void {
    clearTimeout(this.tapTimer);
    if (this.previewHost) { this.previewPlayback = { status: { phase: "loading", progress: 0 } }; this.previewChannel = "motions"; if (this.previewMode === "raw") { this.controller?.previewExpression(null); this.restoreNeutralPose(); } }
    this.controller?.previewMotion(id);
  }
  resetResourcePreview(): void { this.endPreview(); this.restoreNeutralPose(); this.previewChannel = null; if (this.previewHost) this.controller?.beginPreview(); }
  endPreview(): void { this.previewPlayback = null; if (!this.controller?.previewActive) return; this.controller.endPreview(); this.model?.internalModel?.motionManager.stopAllMotions(); }
  getPreviewPlayback(): PreviewPlayback | null {
    const playback = this.previewPlayback;
    if (!playback) return null;
    if (playback.entry) return motionPlayback(playback.entry);
    if (playback.expressionStarted !== undefined) {
      const progress = Math.min(1, Math.max(0, (performance.now() - playback.expressionStarted) / 250));
      return { phase: progress === 1 ? "finished" : "playing", progress };
    }
    return playback.status;
  }
  getPerformanceTrace() { return this.controller?.trace ?? []; }
  cancelPerformance(): void { this.previewPlayback = null; clearTimeout(this.tapTimer); this.controller?.cancel(); this.speechMouth.clear(); this.model?.internalModel?.motionManager.stopAllMotions(); }
  tap(): void {
    if (this.previewHost) return;
    clearTimeout(this.tapTimer);
    const epoch = this.epoch;
    const motion = this.catalog?.motions.find(m => m.aliases.includes("TapBody/0"));
    if (motion) this.previewMotion(motion.name);
    this.tapTimer = setTimeout(() => { if (epoch === this.epoch) this.endPreview(); }, 1200);
  }

  dispose(): void {
    this.viewportObserver?.disconnect(); this.viewportObserver = null;
    this.previewLease++;
    this.previewHost = null; this.previewAvatarId = null; this.chatHost = null;
    this.epoch++;
    this.cancelPerformance();
    this.catalog = null;
    this.controller = null;
    this.requestedAvatar = "";
    this.loading = null;
    this.model = null;
    this.bounds = null;
    if (this.app) {
      // removeView=false：canvas 归 React 管，不从 DOM 移除。
      this.app.destroy(false, { children: true });
      this.app = null;
    }
  }
}

let stage: Live2DStage | null = null;

/** 全局舞台单例。标题页用不透明底色盖住画布，因此立绘实际只在对话页可见。 */
export function getStage(): Live2DStage {
  stage ??= new Live2DStage();
  return stage;
}

/** 模型 url：默认 vendored Hiyori；VITE_MOMO_AVATAR_URL 可覆盖。 */
function avatarModelUrl(): string {
  const v = import.meta.env.VITE_MOMO_AVATAR_URL;
  return typeof v === "string" && v.trim() ? v : DEFAULT_AVATAR_URL;
}
