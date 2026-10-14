// 自绘下拉选择：原生 <select> 的默认弹层与整页设计语言脱节。
// 结构 = 值框（描边圆角 + 右端箭头）+ 浮层选项列（选中左侧金条、悬停浅金底）。
// 交互：点击开合；外点/Esc 关；↑↓ 移动高亮，Enter 选定。

import { useEffect, useRef, useState } from "react";
import "../styles/controls.css";

export interface SelectOption {
  value: string;
  label: string;
}

export default function Select({
  value,
  options,
  onChange,
}: {
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const idx = options.findIndex((o) => o.value === value);
  const current = idx >= 0 ? options[idx] : undefined;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // 开合时高亮对齐当前值，并滚动进可视区。
  useEffect(() => {
    if (open) {
      setHl(Math.max(0, idx));
      listRef.current
        ?.querySelector(".sel-opt.on")
        ?.scrollIntoView({ block: "nearest" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = (v: string): void => {
    onChange(v);
    setOpen(false);
  };

  const onKey = (e: React.KeyboardEvent): void => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setHl((h) => {
        const n =
          e.key === "ArrowDown"
            ? Math.min(options.length - 1, h + 1)
            : Math.max(0, h - 1);
        listRef.current
          ?.querySelectorAll(".sel-opt")
          [n]?.scrollIntoView({ block: "nearest" });
        return n;
      });
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const o = options[hl];
      if (o) pick(o.value);
    }
  };

  return (
    <div className={`sel${open ? " open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="sel-face"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKey}
      >
        <span>{current?.label ?? value}</span>
        <span className="sel-arrow" />
      </button>
      {open && (
        <div className="sel-list" ref={listRef} role="listbox">
          {options.map((o, i) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`sel-opt${o.value === value ? " on" : ""}${
                i === hl ? " hl" : ""
              }`}
              onMouseEnter={() => setHl(i)}
              onClick={() => pick(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
