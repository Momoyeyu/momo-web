// 对话框骨架：铭牌（探出左上）+ 单句字幕；输入行等其余内容由调用方作 children。
//
// 两处复用，页面差异刻意留在各自 CSS：
//   - 对话页：外层 .dialog-zone 负责贴底定位与入场动画，children 是输入行；
//     状态指示器（.chat-status）由页面自带，从 status 插槽进来与铭牌同排；
//   - 设置页预览：外层 .dialog-preview 负责尺寸覆盖与 --dialog-alpha 注入，无 children。
// 骨架样式（.dialog-box / .nameplate-row / .nameplate / .subtitle）在 styles/chat.css——
// 与封装前一致，页面仍各自 import 自己那份 CSS，这里不额外引样式以免改变打包顺序。
import type { ReactNode } from "react";

export default function DialogBox({
  name,
  text,
  status,
  children,
}: {
  /** 铭牌文案（说话人显示名，见 backend/resources/soul.md）。 */
  name: string;
  /** 字幕内容：当前句 / 预览文本。 */
  text: ReactNode;
  /** 铭牌右侧的状态标注（对话页的引擎状态；不传则只显示铭牌）。 */
  status?: ReactNode;
  /** 字幕之后的附加内容（对话页的输入行）。 */
  children?: ReactNode;
}) {
  return (
    <div className="dialog-box">
      <div className="nameplate-row">
        <div className="nameplate">{name}</div>
        {status}
      </div>
      <div className="subtitle">{text}</div>
      {children}
    </div>
  );
}
