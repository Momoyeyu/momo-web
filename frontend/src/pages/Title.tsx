// 主页：左上品牌 + 右侧视觉小说式菜单（胶囊按钮、悬停饰标、错峰入场）。
// 透明区域点击穿透到 Live2D 画布（模型可点）。

import { navigate, type SessionsMode } from "../router";
import { useT } from "../i18n";
import "../styles/title.css";

const MENU: {
  route: "chat" | "sessions" | "settings";
  labelKey: string;
  hint: string;
  sessionsMode?: SessionsMode;
}[] = [
  { route: "chat", labelKey: "title.start", hint: "start" },
  {
    route: "sessions",
    labelKey: "sessions.save",
    hint: "save",
    sessionsMode: "save",
  },
  {
    route: "sessions",
    labelKey: "sessions.load",
    hint: "load",
    sessionsMode: "load",
  },
  { route: "settings", labelKey: "title.config", hint: "config" },
];

export default function Title() {
  const t = useT();
  return (
    <div className="title-screen">
      <header className="title-brand">
        <h1 className="title-logo">momo</h1>
        <div className="title-rule" />
        <p className="title-tagline">{t("title.tagline")}</p>
      </header>

      <nav className="title-menu">
        {MENU.map((m, i) => (
          <button
            key={m.labelKey}
            className="menu-item"
            style={{ animationDelay: `${0.12 + i * 0.08}s` }}
            onClick={() =>
              navigate(
                m.route,
                m.sessionsMode ? { sessionsMode: m.sessionsMode } : undefined,
              )
            }
          >
            <span className="mi-orn" />
            <span className="mi-label">{t(m.labelKey)}</span>
            <span className="mi-hint">{m.hint}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
