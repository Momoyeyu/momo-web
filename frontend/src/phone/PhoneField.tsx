/** Paired phase curves: a quiet echo of the title's rotary-position motif.
 * Static geometry is shared across renders; motion belongs to the wrapper. */
const curves = [0, 1, 2, 3].map(pair => {
 const points = Array.from({length: 49}, (_, i) => {
  const t = i / 48;
  return `${(t * 240).toFixed(1)},${(110 + Math.sin(t * Math.PI * (pair < 2 ? 2 : 4) + (pair % 2) * Math.PI / 2) * (pair < 2 ? 39 : 20)).toFixed(1)}`;
 });
 return <polyline key={pair} points={points.join(' ')} />;
});
const geometry = <svg viewBox="0 0 240 220" fill="none" aria-hidden="true">
 <path className="phone-field-axis" d="M0 110H240M120 12V208" />
 <g className="phone-field-waves">{curves}</g>
 <g className="phone-field-orbit"><ellipse cx="120" cy="110" rx="74" ry="38" transform="rotate(-32 120 110)"/><ellipse cx="120" cy="110" rx="74" ry="38" transform="rotate(32 120 110)"/></g>
 <g className="phone-field-nodes"><circle cx="120" cy="110" r="3"/><circle cx="46" cy="110" r="1.5"/><circle cx="194" cy="110" r="1.5"/></g>
</svg>;
export default function PhoneField(){return <div className="phone-field" aria-hidden="true">{geometry}<span className="phone-field-bit bit-a">01</span><span className="phone-field-bit bit-b">10</span></div>;}
