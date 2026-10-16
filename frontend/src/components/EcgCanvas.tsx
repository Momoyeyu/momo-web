// 标题页心电图粒子背景：粒子带沿 ECG 波形轨迹缓慢滚动 + 深色暖光底色。
// 纯 WebGL 实现，无第三方渲染依赖：
//   - ECG 波形为解析式高斯叠加（P-QRS-T 复合波），在顶点 shader 内求值
//   - ~65bpm 节律规整地向右滚动；每跳振幅由 beat hash 自然起伏
//   - R 波峰处粒子提亮放大——每跳一次「搏动」闪烁
//   - 加法混合点精灵；prefers-reduced-motion / 页面隐藏时停帧

import { useEffect, useRef } from "react";

const BG_FRAG = `precision highp float;
varying vec2 vUv;
uniform float uCentre,uGlow;
void main(){
 // 底色与 var(--bg) 一致（#16121a），波形带区域铺一层暖色微光
 vec3 base=vec3(.086,.071,.102);
 vec2 pool=(vUv-vec2(.5,uCentre))/vec2(.62,.34);
 float lamp=exp(-dot(pool,pool)*2.4);
 vec3 warm=vec3(.30,.20,.10);
 vec3 color=base+warm*lamp*uGlow;
 gl_FragColor=vec4(color,1.0);
}`;

const PT_VERT = `precision highp float;
attribute vec3 position;
attribute vec2 aStyle;
uniform float uTime,uTravel,uWaveCentre,uDpr;
varying float vAlpha,vDepth;
// ECG 复合波：P-QRS-T 各峰为不同幅度/宽度的高斯，p∈[0,1) 一次心跳
float ecg(float p){
 return .10*exp(-pow((p-.16)/.050,2.0))
      -.11*exp(-pow((p-.355)/.016,2.0))
      +1.00*exp(-pow((p-.400)/.013,2.0))
      -.24*exp(-pow((p-.445)/.018,2.0))
      +.20*exp(-pow((p-.640)/.065,2.0));
}
float beatHash(float n){return fract(sin(n*127.1)*43758.5453);}
void main(){
 float u=fract(position.x-uTravel*.68);  // 粒子向左漂，与右移的波前对冲
 float seed=aStyle.y,t=uTime;
 // ~32bpm 持续右移；整屏 ~3.5 次心跳
 float phase=u*3.5-t*.54;
 float idx=floor(phase);
 float p=fract(phase);
 // 节律规整（正常心率）；每跳振幅自然起伏（0.75x~1.25x）
 float amp=.75+.50*beatHash(idx);
 float beat=ecg(p)*amp;
 // R 峰附近粒子提亮+放大 → 每跳有一次「搏动」闪烁
 float pulse=exp(-pow((p-.40)/.10,2.0));
 float width=.022+.006*sin(u*14.0-t*.5);   // 线条横向厚度（微起伏）
 float across=position.y*width;
 float depth=position.z*.04+across*.6;
 vec2 uv=vec2(.5+(u-.5)*1.08,uWaveCentre+beat*.18+across+position.z*.014);
 float edges=smoothstep(0.0,.03,u)*(1.0-smoothstep(.97,1.0,u));
 float bounds=smoothstep(.05,.14,uv.y)*(1.0-smoothstep(.68,.80,uv.y));
 float filaments=.63+.37*pow(.5+.5*sin(position.y*34.0),4.0);
 float tail=mix(1.0,.28,smoothstep(1.0,2.9,abs(position.y)));
 vDepth=clamp(.5+depth*1.9,0.0,1.0);
 vAlpha=(.06+seed*.12)*filaments*tail*edges*bounds*(.5+1.2*pulse);
 float size=(1.0+seed*.9+vDepth*.4)*(1.0+pulse*1.3)*uDpr;
 gl_PointSize=max(1.0,size);
 gl_Position=vec4(uv*2.0-1.0,0.0,1.0);
}`;

const PT_FRAG = `precision highp float;
varying float vAlpha,vDepth;
void main(){
 float radius=length(gl_PointCoord-.5);
 float dot=1.0-smoothstep(.20,.50,radius);
 if(dot<.01)discard;
 vec3 silver=mix(vec3(.55,.60,.72),vec3(.98,.98,1.0),vDepth);
 gl_FragColor=vec4(silver,vAlpha*dot);
}`;

const QUAD_VERT =
  "precision highp float;attribute vec2 aPos;varying vec2 vUv;" +
  "void main(){vUv=aPos*.5+.5;gl_Position=vec4(aPos,0.0,1.0);}";

const COUNT = 96000;

/** 确定性 PRNG（与原版同款 LCG），保证粒子分布稳定。 */
function makeRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s + 0.5) / 4294967296;
  };
}

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("shader alloc failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const kind = type === gl.VERTEX_SHADER ? "vs" : "fs";
    throw new Error(
      `${kind}: log=${JSON.stringify(gl.getShaderInfoLog(sh))} ` +
        `lost=${gl.isContextLost()} err=${gl.getError()} ` +
        `src=${src.slice(0, 60)}`,
    );
  }
  return sh;
}

function program(
  gl: WebGLRenderingContext,
  vs: string,
  fs: string,
): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error("program alloc failed");
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p) ?? "link failed");
  }
  return p;
}

export default function EcgCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      powerPreference: "high-performance",
    });
    if (!gl) return;

    // WebGL 初始化失败（shader 编译/GPU 拒绝）只损失背景，不拖垮页面
    try {
      return init(gl, canvas);
    } catch (e) {
      return undefined;
    }

    function init(
      gl: WebGLRenderingContext,
      canvas: HTMLCanvasElement,
    ): () => void {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let disposed = false;
    let raf = 0;
    let last = 0;
    let time = 0;
    let travelled = 0;
    let visible = true;

    // ---- 背景（全屏 quad + 星云辉光） ----
    const bgProg = program(gl, QUAD_VERT, BG_FRAG);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const bgLoc = {
      aPos: gl.getAttribLocation(bgProg, "aPos"),
      uCentre: gl.getUniformLocation(bgProg, "uCentre"),
      uGlow: gl.getUniformLocation(bgProg, "uGlow"),
    };

    // ---- 粒子 ----
    const ptProg = program(gl, PT_VERT, PT_FRAG);
    const rand = makeRandom(22092026);
    const positions = new Float32Array(COUNT * 3);
    const styles = new Float32Array(COUNT * 2);
    for (let i = 0; i < COUNT; i++) {
      positions[i * 3] = rand();
      const spread = i % 4 === 0 ? 0.95 : 0.44;
      positions[i * 3 + 1] = Math.max(
        -3,
        Math.min(
          3,
          Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand()),
        ),
      ) * spread;
      positions[i * 3 + 2] = rand() * 2 - 1;
      styles[i * 2] = i % 2;
      styles[i * 2 + 1] = rand();
    }
    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    const styBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, styBuf);
    gl.bufferData(gl.ARRAY_BUFFER, styles, gl.STATIC_DRAW);
    const ptLoc = {
      position: gl.getAttribLocation(ptProg, "position"),
      aStyle: gl.getAttribLocation(ptProg, "aStyle"),
      uTime: gl.getUniformLocation(ptProg, "uTime"),
      uTravel: gl.getUniformLocation(ptProg, "uTravel"),
      uWaveCentre: gl.getUniformLocation(ptProg, "uWaveCentre"),
      uDpr: gl.getUniformLocation(ptProg, "uDpr"),
    };

    gl.enable(gl.BLEND);

    const dpr = Math.min(devicePixelRatio || 1, 1.25);
    let drawCount = COUNT;

    const resize = (): void => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
      drawCount = Math.max(4500, Math.min(COUNT, Math.round(w * h * 0.009)));
    };

    const paint = (): void => {
      // 背景
      gl.disable(gl.BLEND);
      gl.useProgram(bgProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(bgLoc.aPos);
      gl.vertexAttribPointer(bgLoc.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1f(bgLoc.uCentre, 0.38);
      gl.uniform1f(bgLoc.uGlow, 0.9);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // 粒子带
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE); // additive
      gl.useProgram(ptProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.enableVertexAttribArray(ptLoc.position);
      gl.vertexAttribPointer(ptLoc.position, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, styBuf);
      gl.enableVertexAttribArray(ptLoc.aStyle);
      gl.vertexAttribPointer(ptLoc.aStyle, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1f(ptLoc.uTime, time);
      gl.uniform1f(ptLoc.uTravel, travelled);
      gl.uniform1f(ptLoc.uWaveCentre, 0.38);
      gl.uniform1f(ptLoc.uDpr, dpr);
      gl.drawArrays(gl.POINTS, 0, drawCount);
    };

    const tick = (now: number): void => {
      raf = 0;
      if (disposed || document.hidden || !visible) {
        last = 0;
        return;
      }
      const delta = last ? Math.min((now - last) / 1000, 0.05) : 1 / 60;
      last = now;
      if (!reduced.matches) {
        time += delta;
        travelled += delta * 0.072;
      }
      paint();
      if (!reduced.matches) raf = requestAnimationFrame(tick);
      else last = 0;
    };
    const schedule = (): void => {
      if (!raf && !disposed && !document.hidden)
        raf = requestAnimationFrame(tick);
    };

    const onVis = (): void => {
      last = 0;
      schedule();
    };
    const onMotion = (): void => {
      last = 0;
      paint();
      schedule();
    };
    const io = new IntersectionObserver(
      ([e]) => {
        visible = e.isIntersecting;
        last = 0;
        schedule();
      },
      { threshold: 0.05 },
    );
    io.observe(canvas);
    const ro = new ResizeObserver(() => {
      resize();
      paint();
      schedule();
    });
    ro.observe(canvas);

    document.addEventListener("visibilitychange", onVis);
    reduced.addEventListener("change", onMotion);
    canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());

    resize();
    paint();
    schedule();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      reduced.removeEventListener("change", onMotion);
      // 不主动 loseContext：StrictMode 双挂载下第二次 init 会拿到已丢失的
      // 同 context；canvas 卸载时由 GC 自然回收。
    };
    }
  }, []);

  return <canvas ref={ref} className="ecg-canvas" aria-hidden="true" />;
}
