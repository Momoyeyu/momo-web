// 设置页三段式（对照柚子社 config 结构）：
//   顶部 tab 条——独立全宽容器，页签均分铺满；金色高亮滑块随 tab 平移；
//   中部内容——四个 tab 的面板横排成滑轨（手机桌面式左右切换），各自内滚；
//   底部操作条——返回按钮聚拢右下。
// 背景是与标题页同一把标尺的网格（GridBackdrop），每个 tab 拥有自己的
// 正交坐标系 θ_k = k · 15°（RoPE 式位置-旋转映射）：切换 tab 时网格旋转、
// 高亮滑块平移、内容横滑三者同步完成——一次统一、快速的坐标系变换。
// 即改即生效：各控件直接 update() 落盘（localStorage + 防抖 PUT /api/state），
// 无草稿/保存概念——语言切换等立即生效。

import { useState } from "react";

import { useT } from "../i18n";
import { fromRoute, navigate } from "../router";
import Button from "../ui/Button";
import BuiltinResourcesNotice from "../components/BuiltinResourcesNotice";
import GridBackdrop from "../components/GridBackdrop";
import { ropeFrom } from "../lib/ropeAngle";
import MemoryPanel from "./panels/Memory";
import ExtensionsTab from "./settings/ExtensionsTab";
import GeneralTab from "./settings/GeneralTab";
import ModelsTab from "./settings/ModelsTab";
import "../styles/settings.css";

type Section = "general" | "models" | "memory" | "extend";

const TABS: Section[] = ["general", "models", "memory", "extend"];
// RoPE：位置 k → 旋转角 θ_k = 25° + k·70°。起点偏 25° 让「通用」与标题页
//（0°）也明显不同；步长 70° 让每次切换都有大幅度的旋转张力，而任意两档
// 直接切换的最大扫角 210° 不超过一圈。四个落角都不是 90° 的倍数——
// 网格在 90° 整数倍上会与 0° 视觉重合，避开后每档坐标系都看得出来。
// 画布 y 轴向下，正角即顺时针：向右切 tab 顺时针、向左切逆时针。
const ROT_BASE = 25;
const ROT_STEP = 70;

export default function Settings() {
  const t = useT();
  const [tab, setTab] = useState<Section>("general");
  const backRoute = fromRoute() === "chat" ? ("chat" as const) : ("title" as const);
  const backLabel =
    backRoute === "chat" ? t("common.backChat") : t("common.backTitle");
  const idx = TABS.indexOf(tab);

  return (
    <div className="settings-page">
      <GridBackdrop angle={ROT_BASE + idx * ROT_STEP} from={ropeFrom()} sweepMs={620} />
      <nav className="tabstrip">
        <div className="tabstrip-inner">
          {/* 金色高亮滑块：宽度=1/4，translateX 按下标平移，随内容同节奏滑动 */}
          <span
            className="stab-thumb"
            style={{ transform: `translateX(${idx * 100}%)` }}
          />
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
      {/* 滑轨：四个面板常驻横排，translateX 切换——像手机多桌面横滑 */}
      <div className="settings-scroll">
        <div
          className="settings-track"
          style={{ transform: `translateX(${-idx * 100}%)` }}
        >
          <section
            className="settings-pane"
            aria-hidden={tab !== "general" ? true : undefined}
            inert={tab !== "general"}
          >
            <div className="settings-content">
              <div className="settings-body">
                <GeneralTab />
              </div>
            </div>
          </section>
          <section
            className="settings-pane"
            aria-hidden={tab !== "models" ? true : undefined}
            inert={tab !== "models"}
          >
            <div className="settings-content">
              <div className="settings-body">
                <ModelsTab />
              </div>
            </div>
          </section>
          <section
            className="settings-pane"
            aria-hidden={tab !== "memory" ? true : undefined}
            inert={tab !== "memory"}
          >
            <div className="settings-content">
              <MemoryPanel />
            </div>
          </section>
          <section
            className="settings-pane"
            aria-hidden={tab !== "extend" ? true : undefined}
            inert={tab !== "extend"}
          >
            <div className="settings-content">
              <div className="settings-body">
                <ExtensionsTab />
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* 底部操作条：返回按钮聚拢右下 */}
      <footer className="footbar">
        <div className="footbar-inner">
          <BuiltinResourcesNotice />
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
