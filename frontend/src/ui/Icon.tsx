// 纯图标：只画 svg，不带按钮外观 —— 需要可点时由调用方套 Button / IconButton。
// 线宽与端点在这里统一，图标本身只关心路径，因此整套图标线宽必然一致。
import { ICONS, type IconName } from "./icons";

export default function Icon({
  name,
  size = 18,
}: {
  name: IconName;
  /** 正方形边长（px）。 */
  size?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICONS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
