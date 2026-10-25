// 回到同一个 momo。进入见面不清空记录，也不恢复另一条时间线。
import {navigate} from "../router";
import {useT} from "../i18n";
import EcgCanvas from "../components/EcgCanvas";
import Button from "../ui/Button";
import {PRESENCE_URL,TITLE_PRESENCE} from "../lib/presenceTransition";
import "../styles/title.css";

export default function Title() {
  const t = useT();
  const items = [
    {key: "meet", labelKey: "title.start", hint: "meet", onClick: () => navigate("chat")},
    {key: "config", labelKey: "title.config", hint: "config", onClick: () => navigate("settings")},
  ];

  return (
    <div className="title-screen">
      <EcgCanvas />
      <img className="title-presence" src={PRESENCE_URL} style={{left:`${TITLE_PRESENCE.left*100}%`,top:`${TITLE_PRESENCE.top*100}%`,width:`${TITLE_PRESENCE.width*100}%`}} width="1024" height="1536" alt="" aria-hidden="true" decoding="async" />
      <header className="title-brand">
        <h1 className="title-logo" aria-label="momo"><img className="title-brand-mark" src="/brand/momo-mark.svg" alt="" /><img className="title-brand-wordmark" src="/brand/momo-wordmark.svg" alt="momo" /></h1>
        <div className="title-rule" />
        <p className="title-tagline">{t("title.tagline")}</p>
      </header>

      <nav className="title-menu">
        {items.map((m, i) => (
          <Button
            key={m.key}
            className="menu-item"
            style={{ animationDelay: `${0.12 + i * 0.08}s` }}
            onClick={m.onClick}
          >
            <span className="mi-orn" />
            <span className="mi-label">{t(m.labelKey)}</span>
            <span className="mi-hint">{m.hint}</span>
          </Button>
        ))}
      </nav>
    </div>
  );
}
