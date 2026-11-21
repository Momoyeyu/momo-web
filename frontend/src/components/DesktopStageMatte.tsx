import {useState} from 'react';

const motifs = ['pulse', 'phase', 'hello'] as const;
type Motif = typeof motifs[number];

function Ornament({motif}: {motif: Motif}) {
  return <div className="stage-matte-motif">
    {motif === 'pulse' ? <svg className="stage-matte-pulse" viewBox="0 0 180 20" fill="none"
      stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
      <path className="stage-matte-lead" d="M1 11h59m60 0h59"/>
      <path d="M64 11h9l4-3 5 3h4l3 2L93 3l4 14 4-6h3q6-6 11 0h1"/>
    </svg> : <>
      <i className="stage-matte-rule"/>
      <code>{motif === 'phase' ? 'R(m)ᵀR(n) = R(n−m)' : 'std::cout << "hello, human";'}</code>
      <i className="stage-matte-rule"/>
    </>}
  </div>;
}

export default function DesktopStageMatte() {
  // One pair of ornaments per renderer lifetime, independent of routes and window size.
  const [motif] = useState(() => motifs[Math.floor(Math.random() * motifs.length)]!);
  return <div className="desktop-stage-matte" aria-hidden="true" data-motif={motif}>
    <div className="desktop-stage-matte-outline"/>
    {(['top', 'left'] as const).map(edge => <div className="stage-matte-edge" key={edge} data-edge={edge}>
      <img className="stage-matte-mark" src="/brand/momo-mark.svg" alt="" draggable={false}/>
    </div>)}
    {(['bottom', 'right'] as const).map(edge => <div className="stage-matte-edge" key={edge} data-edge={edge}>
      <Ornament motif={motif}/>
    </div>)}
  </div>;
}
