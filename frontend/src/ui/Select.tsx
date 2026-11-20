import {ambient} from '../audio/ambient';
// 自绘下拉选择：原生 <select> 的默认弹层与整页设计语言脱节。
// 结构 = 值框（描边圆角 + 右端箭头）+ 浮层选项列（选中左侧金条、悬停浅金底）。
// 交互：点击开合；外点/Esc 关；↑↓ 移动高亮，Enter 选定。

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "../styles/controls.css";

export interface SelectOption {
  value: string;
  label: string;
}

export default function Select({
  label,
  value,
  options,
  onChange,
  disabled = false,
  onOpen,
  popupNotice,
  hideOptions = false,
  reopenKey,
}: {
  label?: string;
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
  disabled?: boolean;
  onOpen?: () => void;
  popupNotice?: ReactNode;
  hideOptions?: boolean;
  reopenKey?: number;
}) {
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const faceRef = useRef<HTMLButtonElement | null>(null);
  const lastReopen = useRef(reopenKey);

  useEffect(() => {
    if (lastReopen.current === reopenKey || disabled) return;
    lastReopen.current = reopenKey;
    setOpen(true);
    faceRef.current?.focus();
  }, [reopenKey, disabled]);

  const idx = options.findIndex((o) => o.value === value);
  const current = idx >= 0 ? options[idx] : undefined;

  useEffect(() => {
    if (!open || disabled) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, disabled]);

  // 开合时高亮对齐当前值，并滚动进可视区。
  useEffect(() => {
    if (open) {
      setHl(Math.max(0, idx));
      listRef.current
        ?.querySelector(".sel-opt.on")
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [open, disabled, idx]);

  // Fit within every scrolling ancestor, not just the browser viewport.
  useLayoutEffect(() => {
    if (!open || disabled) return;
    const root = rootRef.current, list = listRef.current;
    if (!root || !list) return;
    const fit = () => {
      const rect = root.getBoundingClientRect();
      let top = 0, bottom = innerHeight;
      for (let parent = root.parentElement; parent; parent = parent.parentElement) {
        if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
          const bounds = parent.getBoundingClientRect();
          top = Math.max(top, bounds.top + parent.clientTop);
          bottom = Math.min(bottom, bounds.top + parent.clientTop + parent.clientHeight);
        }
      }
      const below = bottom - rect.bottom - 8, above = rect.top - top - 8;
      const up = below < Math.min(list.scrollHeight + 2, 220) && above > below;
      list.style.top = up ? "auto" : "calc(100% + 6px)";
      list.style.bottom = up ? "calc(100% + 6px)" : "auto";
      list.style.maxHeight = `${Math.max(0, Math.min(220, up ? above : below))}px`;
    };
    const scroll = (event: Event) => { if (!list.contains(event.target as Node)) fit(); };
    fit();
    window.addEventListener("resize", fit);
    document.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("resize", fit);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [open, disabled, hideOptions, options.length, popupNotice]);

  const pick = (v: string): void => {
    onChange(v);
    if(v!==value)ambient.sound("tap");
    setOpen(false);
  };

  const show = () => {
    onOpen?.();
    setOpen(true);
  };

  const onKey = (e: React.KeyboardEvent): void => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (!hideOptions && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
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
      if (o && !hideOptions) pick(o.value);
    }
  };

  return (
    <div className={`sel${open ? " open" : ""}`} ref={rootRef}>
      <button
        ref={faceRef}
        type="button"
        className="sel-face"
        aria-label={label ? label + ' · ' + (current?.label ?? value) : undefined}
        aria-expanded={open && !disabled}
        disabled={disabled}
        aria-haspopup="listbox"
        onClick={() => open ? setOpen(false) : show()}
        onKeyDown={onKey}
      >
        <span title={current?.label ?? value}>{current?.label ?? value}</span>
        <span className="sel-arrow" />
      </button>
      {open && !disabled && (
        <div className="sel-list" ref={listRef}>
          <div role="listbox">{!hideOptions && options.map((o, i) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              title={o.label}
              className={`sel-opt${o.value === value ? " on" : ""}${
                i === hl ? " hl" : ""
              }`}
              onMouseEnter={() => setHl(i)}
              onClick={() => pick(o.value)}
            >
              {o.label}
            </button>
          ))}</div>
          {popupNotice}
        </div>
      )}
    </div>
  );
}
