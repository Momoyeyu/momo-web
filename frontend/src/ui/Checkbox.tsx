import type { InputHTMLAttributes } from "react";
import Icon from "./Icon";
import "../styles/controls.css";

/** Native keyboard/checked semantics, with the same surface as other controls. */
export default function Checkbox(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return <label className="check-control">
    <input {...props} type="checkbox" />
    <span aria-hidden="true"><Icon name="check" size={14} /></span>
  </label>;
}
