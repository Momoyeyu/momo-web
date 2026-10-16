// 对话框骨架：铭牌（探出左上）+ 单句字幕；输入行等其余内容由调用方作 children。
//
// 两处复用，页面差异刻意留在各自 CSS：
//   - 对话页：外层 .dialog-zone 负责贴底定位与入场动画，children 是输入行；
//   - 设置页预览：外层 .dialog-preview 负责尺寸覆盖与 --dialog-alpha 注入，无 children。
// 骨架样式（.dialog-box / .nameplate / .subtitle）在 styles/chat.css——与封装前一致，
// 页面仍各自 import 自己那份 CSS，这里不额外引样式以免改变打包顺序。
import type { ReactNode } from "react";

export default function DialogBox({
  name,
  text,
  children,
}: {
  /** 铭牌文案（人格名称）。 */
  name: string;
  /** 字幕内容：当前句 / 预览文本。 */
  text: ReactNode;
  /** 字幕之后的附加内容（对话页的输入行）。 */
  children?: ReactNode;
}) {
  return (
    <div className="dialog-box">
      <div className="nameplate">{name}</div>
      <div className="subtitle">{text}</div>
      {children}
    </div>
  );
}
