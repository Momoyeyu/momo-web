// 子页头部：左标题 + 右操作区（通常是一个「返回」按钮）。
//
// 结构固定为 header > h1 + actions；两页的外观差异（间距、按钮尺寸的写法不同）
// 留在各自 CSS，靠 className 传入：.checkpoint-head / .backlog-head。
import type { ReactNode } from "react";

export default function PageHeader({
  title,
  actions,
  className,
}: {
  /** 页面标题（存档页随模式变）。 */
  title: ReactNode;
  /** 右端操作区（返回键等）。 */
  actions?: ReactNode;
  /** 页面头部类名——各页样式不同，必须显式给。 */
  className: string;
}) {
  return (
    <header className={className}>
      <h1>{title}</h1>
      {actions}
    </header>
  );
}
