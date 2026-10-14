// 全窗口 Live2D 画布：应用级常驻（模型始终预加载），
// 但仅 chat 场景可见——与视觉小说一致：角色立绘只出现在对话场景。
// 加载失败时静默降级（背景图仍在，面板可正常用）。

import { useEffect, useRef } from "react";
import { getAvatarId, subscribe } from "../lib/store";
import { getStage } from "./stage";

export default function StageCanvas({ visible }: { visible: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const stage = getStage();
    try {
      // 幂等：StrictMode 双挂载对同一 canvas 重复 init 会被跳过。
      stage.init(canvas);
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
    return subscribe(load);
    // 不随组件卸载 dispose：舞台是应用级常驻单例。
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 0,
        backgroundImage:
          "linear-gradient(rgba(20, 16, 26, 0.45), rgba(20, 16, 26, 0.72)), url(/stage/stage-room.jpg)",
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          opacity: visible ? 1 : 0,
          transition: "opacity 0.45s ease",
          pointerEvents: visible ? "auto" : "none",
        }}
        onClick={() => {
          // 轻拍回应：模型未就绪时 playEmotion 自身静默 no-op。
          getStage().playEmotion("happy");
        }}
      />
    </div>
  );
}
