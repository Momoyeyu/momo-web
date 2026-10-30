import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "../styles/controls.css";

/** One transient layer, outside transformed pages and scroll containers. */
export default function TooltipLayer() {
  const [expanded, setExpanded] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const trigger = (target: EventTarget | null) => target instanceof Element
      ? target.closest<HTMLElement>(".tip[data-tip],button[data-tip]") : null;
    let timer:ReturnType<typeof setTimeout>;
    const over = (event: MouseEvent) => {
      clearTimeout(timer);
      if(event.target instanceof Node&&bubble.current?.contains(event.target))return;
      setAnchor(trigger(event.target));
    };
    const out = (event: MouseEvent) => {
      const next = trigger(event.relatedTarget);
      if(event.relatedTarget instanceof Node&&bubble.current?.contains(event.relatedTarget))return;
      if(next)return;
      timer=setTimeout(()=>setAnchor(null),140);
    };
    const focus = (event: FocusEvent) => {
      const el = trigger(event.target);
      if (el?.matches(":focus-visible")) setAnchor(el);
    };
    const hide = (event?:Event) => {
      if(event?.target instanceof Node&&bubble.current?.contains(event.target))return;
      if(event instanceof FocusEvent&&event.relatedTarget instanceof Node&&bubble.current?.contains(event.relatedTarget))return;
      setAnchor(null);
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setAnchor(null); };
    document.addEventListener("mouseover", over);
    document.addEventListener("mouseout", out);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", hide);
    document.addEventListener("scroll", hide, true);
    document.addEventListener("click", hide);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", hide);
    return () => {
      clearTimeout(timer);
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
  useEffect(()=>setExpanded(false),[anchor]);
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
  }, [anchor,expanded]);
  return anchor?.isConnected && anchor.dataset.tip ? createPortal(
    <div key={anchor.dataset.tip} ref={bubble} role={anchor.dataset.tipDetail?"dialog":"tooltip"} aria-label={anchor.dataset.tip} className="tooltip-bubble" style={{ visibility: "hidden" }}>
      <span>{anchor.dataset.tip}</span>
      {anchor.dataset.tipDetail&&<button type="button" className="tooltip-help" aria-expanded={expanded} aria-label={anchor.dataset.tip} onClick={()=>setExpanded(v=>!v)}>?</button>}
      {expanded&&<p className="tooltip-detail">{anchor.dataset.tipDetail}</p>}
    </div>, document.body,
  ) : null;
}
