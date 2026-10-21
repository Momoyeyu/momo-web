// 全窗口 Live2D 画布：应用级常驻（模型始终预加载），
// 但仅 chat 场景可见——与视觉小说一致：角色立绘只出现在对话场景。
// 加载失败时静默降级（背景图仍在，面板可正常用）。

import { useEffect, useRef } from "react";
import { getAvatarId, subscribe } from "../lib/store";
import { getStage } from "./stage";

export default function StageCanvas({ visible }: { visible: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const homeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const home = homeRef.current;
    if (!home) return;
    const canvas = canvasRef.current ??= document.createElement("canvas");
    canvas.className = "live2d-canvas";
    Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%" });
    const stage = getStage();
    try {
      // 幂等：StrictMode 双挂载对同一 canvas 重复 init 会被跳过。
      stage.init(canvas);
      stage.setChatHost(home);
    } catch {
      return; // WebGL 不可用等：背景图兜底，页面照常可用
    }
    // 加载当前形象并订阅切换（设置页换模型即时生效；
    // 同模型重复调用在 stage 内去重，导入失败内部回退内置）。
    let lastId: string | null = null;
    const load = (): void => {
      const id = getAvatarId();
      if (id === lastId) return;
      lastId = id;
      void stage.loadAvatar().catch(() => {});
    };
    load();
    const tap = () => stage.tap();
    canvas.addEventListener("click", tap);
    const unsubscribe = subscribe(load);
    return () => { unsubscribe(); canvas.removeEventListener("click", tap); };
    // 不随组件卸载 dispose：舞台是应用级常驻单例。
  }, []);

  useEffect(() => { getStage().setChatVisible(visible); }, [visible]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 0,
        backgroundImage: "url(/stage/stage-room.jpg)",
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <div className="scene-ambient" aria-hidden="true" />
      <div ref={homeRef} className="live2d-home" style={{ position: "absolute", inset: 0 }} />
      <div className="scene-reading-shade" aria-hidden="true" />
    </div>
  );
}
