import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "../styles/controls.css";

/** One transient layer, outside transformed pages and scroll containers. */
export default function TooltipLayer() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const trigger = (target: EventTarget | null) => target instanceof Element
      ? target.closest<HTMLElement>(".tip[data-tip]") : null;
    const over = (event: MouseEvent) => setAnchor(trigger(event.target));
    const out = (event: MouseEvent) => {
      const next = trigger(event.relatedTarget);
      setAnchor(previous => next === previous ? previous : null);
    };
    const focus = (event: FocusEvent) => {
      const el = trigger(event.target);
      if (el?.matches(":focus-visible")) setAnchor(el);
    };
    const hide = () => setAnchor(null);
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    document.addEventListener("mouseover", over);
    document.addEventListener("mouseout", out);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", hide);
    document.addEventListener("scroll", hide, true);
    document.addEventListener("click", hide);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("mouseout", out);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("click", hide);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", hide);
    };
  }, []);
  useLayoutEffect(() => {
    const el = bubble.current;
    if (!anchor || !el) return;
    const stage = document.querySelector(".app-stage")?.getBoundingClientRect();
    const bounds = stage ?? { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth };
    const a = anchor.getBoundingClientRect();
    el.style.maxWidth = `${Math.min(262, bounds.width - 16)}px`;
    const b = el.getBoundingClientRect();
    const above = a.top - b.height - 8, below = a.bottom + 8;
    const preferBelow = anchor.classList.contains("tip-b");
    const top = preferBelow
      ? (below + b.height <= bounds.bottom - 8 ? below : above)
      : (above >= bounds.top + 8 ? above : below);
    const left = anchor.classList.contains("tip-l") ? a.left
      : anchor.classList.contains("tip-r") ? a.right - b.width : a.left + (a.width - b.width) / 2;
    el.style.left = `${Math.max(bounds.left + 8, Math.min(left, bounds.right - b.width - 8))}px`;
    el.style.top = `${Math.max(bounds.top + 8, Math.min(top, bounds.bottom - b.height - 8))}px`;
    el.style.visibility = "visible";
  }, [anchor]);
  return anchor?.isConnected && anchor.dataset.tip ? createPortal(
    <div key={anchor.dataset.tip} ref={bubble} role="tooltip" className="tooltip-bubble" style={{ visibility: "hidden" }}>
      {anchor.dataset.tip}
    </div>, document.body,
  ) : null;
}
