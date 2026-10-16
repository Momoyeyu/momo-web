// 圈内问号 + 悬停解释。
//
// 用途：把「说明书式」的长句从页面上收进浮窗 —— 说明只在用户主动询问时出现，
// 不占版面、不干扰阅读。典型用法是放在某个标题右侧（见设置页「拓展 · MCP」）。
//
// 复用 controls.css 的 .tip 机制（与记忆卡片的图钉同一套浮窗）：
//   .tip    提供 data-tip → ::after 浮窗
//   .tip-b  浮窗朝**下**弹：这东西通常贴在面板顶部，朝上会被滚动容器裁掉
//   .tip-l  左对齐：贴左缘时不至于向左出界
import "../styles/controls.css";

export default function Hint({ text }: { text: string }) {
  return (
    <span
      className="hint tip tip-b tip-l"
      data-tip={text}
      role="img"
      aria-label={text}
      tabIndex={0}
    />
  );
}
