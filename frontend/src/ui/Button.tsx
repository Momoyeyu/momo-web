// 通用按钮：把全站散落的 `ghost` / `small` 类组合收敛成声明式 props。
//
// 刻意**不引入基础类**（没有 .btn）——solid 就是裸 <button>，emit 出来的类串与
// 封装前逐字一致。因此页面私有的按钮形态（.tb / .bl-replay / .menu-item /
// .slot-del / .kv-add / .stab …）直接走 className 逃生口，外观不受影响。
//
// 类的拼装顺序固定为 ghost → small → className，与既有写法一致。
import type { ButtonHTMLAttributes } from "react";
import "../styles/controls.css";

export default function Button({
  variant = "solid",
  size = "md",
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  /** solid = 实心主按钮（默认）；ghost = 描边次按钮。 */
  variant?: "solid" | "ghost";
  /** md = 默认尺寸；sm = 卡片/行内小按钮（原 `small`）。 */
  size?: "md" | "sm";
}) {
  const cls = [
    variant === "ghost" ? "ghost" : "",
    size === "sm" ? "small" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return <button type={type} className={cls || undefined} {...rest} />;
}
