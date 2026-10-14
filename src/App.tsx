import { useEffect } from "react";
import StageCanvas from "./live2d/StageCanvas";
import Title from "./pages/Title";
import Chat from "./pages/Chat";
import Settings from "./pages/Settings";
import Backlog from "./pages/Backlog";
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
  return (
    <>
      <StageCanvas visible={route === "chat"} />
      <div className="page-wrap" key={route}>
        {route === "title" && <Title />}
        {route === "chat" && <Chat />}
        {route === "settings" && <Settings />}
        {route === "backlog" && <Backlog />}
      </div>
    </>
  );
}
