// 设置页三段式（对照柚子社 config 结构）：
//   顶部 tab 条——独立全宽容器，页签均分铺满；
//   中部内容——各 tab 自己的面板（各 tab 组件自己订阅配置）；
//   底部操作条——返回按钮聚拢右下。
// 即改即生效：各控件直接 update() 落盘（localStorage + 防抖 PUT /api/state），
// 无草稿/保存概念——语言切换等立即生效。
import { useState } from "react";

import { useT } from "../i18n";
import { fromRoute, navigate } from "../router";
import Button from "../ui/Button";
import MemoryPanel from "./panels/Memory";
import ExtensionsTab from "./settings/ExtensionsTab";
import GeneralTab from "./settings/GeneralTab";
import ModelsTab from "./settings/ModelsTab";
import "../styles/settings.css";

type Section = "general" | "models" | "memory" | "extend";

const TABS: Section[] = ["general", "models", "memory", "extend"];

export default function Settings() {
  const t = useT();
  const [tab, setTab] = useState<Section>("general");
  const backRoute = fromRoute() === "chat" ? ("chat" as const) : ("title" as const);
  const backLabel =
    backRoute === "chat" ? t("common.backChat") : t("common.backTitle");

  return (
    <div className="settings-page">
      <nav className="tabstrip">
        <div className="tabstrip-inner">
          {TABS.map((id) => (
            <Button
              key={id}
              className={`stab${tab === id ? " active" : ""}`}
              onClick={() => setTab(id)}
            >
              <span className="stab-label">{t(`settings.tabs.${id}`)}</span>
            </Button>
          ))}
        </div>
      </nav>
      <div className="settings-scroll">
        <div className="settings-content">
          {tab === "memory" ? (
            <MemoryPanel />
          ) : (
            <div className="settings-body">
              {tab === "general" && <GeneralTab />}
              {tab === "models" && <ModelsTab />}
              {tab === "extend" && <ExtensionsTab />}
            </div>
          )}
        </div>
      </div>

      {/* 底部操作条：返回按钮聚拢右下 */}
      <footer className="footbar">
        <div className="footbar-inner">
          <div className="foot-right">
            <Button variant="ghost" onClick={() => navigate(backRoute)}>
              {backLabel}
            </Button>
          </div>
        </div>
      </footer>
    </div>
  );
}
