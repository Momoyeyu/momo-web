import { useEffect } from "react";
import StageCanvas from "./live2d/StageCanvas";
import Title from "./pages/Title";
import Chat from "./pages/Chat";
import Settings from "./pages/Settings";
import Backlog from "./pages/Backlog";
import Checkpoint from "./pages/Checkpoint";
import { useRoute } from "./router";
import { getSettings, subscribe } from "./lib/store";

export default function App() {
  const route = useRoute();

  // 对话框不透明度 → CSS 变量，保存后即时生效。
  useEffect(() => {
    const apply = (): void =>
      document.documentElement.style.setProperty(
        "--dialog-alpha",
        String(getSettings().general.dialogOpacity / 100),
      );
    apply();
    return subscribe(apply);
  }, []);

  // key=route 触发整页入场动画（淡入+上浮，VN 换场感）；
  // StageCanvas 在动画层之外，人物不随页面切换跳动。
  // 全部内容锁在 16:9 舞台内（.app-stage）：窗口比例任意，画面比例恒定，
  // 特效/布局无需为不同画面比例做响应式适配。
  return (
    <div className="app-stage">
      <StageCanvas visible={route === "chat"} />
      <div className="page-wrap" key={route}>
        {route === "title" && <Title />}
        {route === "chat" && <Chat />}
        {route === "settings" && <Settings />}
        {route === "backlog" && <Backlog />}
        {route === "checkpoint" && <Checkpoint />}
      </div>
    </div>
  );
}
