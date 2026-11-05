import {useEffect,useRef} from 'react';
import {ambient} from '../audio/ambient';
// 开关控件：pill switch（圆角矩形槽 + 方块钮），role=switch 语义。
import "../styles/controls.css";

export default function Switch({
  on,
  onChange,
  disabled,
  title,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  title?: string;
}) {
  const pending=useRef<{value:boolean;timer:ReturnType<typeof setTimeout>}|null>(null);
  useEffect(()=>{if(pending.current?.value===on){clearTimeout(pending.current.timer);pending.current=null;ambient.sound(on?'on':'off');}},[on]);
  useEffect(()=>()=>{if(pending.current)clearTimeout(pending.current.timer);},[]);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={title}
      className={`switch${on ? " on" : ""}`}
      disabled={disabled}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        if(pending.current)clearTimeout(pending.current.timer);
        pending.current={value:!on,timer:setTimeout(()=>{pending.current=null;},2000)};
        try{onChange(!on);}catch(error){clearTimeout(pending.current.timer);pending.current=null;throw error;}
      }}
    >
      <span className="knob" />
    </button>
  );
}
