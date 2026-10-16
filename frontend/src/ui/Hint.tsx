// 圈内问号 + 悬停解释。
//
// 图标用 Lucide 的 `circle-help`（MIT 许可，直接内联路径，不引依赖）：
// 圆环与问号是同一套描边画出来的，因此问号天然居中、线宽统一、缩放不糊 ——
// 之前用「CSS 画圆 + 文字问号」做不到这三点（文字字形重心偏上，圆环线宽
// 也和文字无关，只能靠 padding 硬凑）。
//
// 尺寸按 em 走：比相邻文字略小一丢丢，并自动跟随所在位置的字号。
//
// 用途：把「说明书式」的长句从页面上收进浮窗，说明只在用户主动询问时出现。
// 复用 controls.css 的 .tip 机制（与图钉同一套浮窗）：
//   .tip      提供 data-tip → ::after 浮窗，默认朝**上**弹
//   side="down"  朝下弹：元素贴在面板顶部时用，朝上会被滚动容器裁掉
//   .tip-l    左对齐：贴左缘时不至于向左出界
import "../styles/controls.css";

export default function Hint({
  text,
  side = "up",
}: {
  /** 解释正文（同时进 data-tip 与 aria-label）。 */
  text: string;
  /** 浮窗朝向。默认朝上；贴着容器顶部的元素用 "down"。 */
  side?: "up" | "down";
}) {
  return (
    <span
      className={`hint tip tip-l${side === "down" ? " tip-b" : ""}`}
      data-tip={text}
      role="img"
      aria-label={text}
      tabIndex={0}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
        <path d="M12 17h.01" />
      </svg>
    </span>
  );
}
