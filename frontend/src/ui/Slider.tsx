// 百分比滑条（0–100）：菱形 thumb + 左金右灰轨道渐变，右侧自带当前值。
// 四处调用点（语音音量 / 对话框透明度 / 文字速度 / 切句速度）都是 0–100 百分比，
// 所以量程与数值格式不做成 props——真出现别的量程时再加。
import "../styles/controls.css";

export default function Slider({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  const fill = {
    background: `linear-gradient(90deg, var(--accent) 0%, var(--accent) ${value}%, var(--line) ${value}%, var(--line) 100%)`,
  };
  return (
    <>
      <input
        type="range"
        className="ux-range"
        min={0}
        max={100}
        step={1}
        disabled={disabled}
        style={fill}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="slider-val">{value}%</span>
    </>
  );
}
