// 换场遮罩形状：一张不规则的"洞"。
// 为什么不用正圆：水滴/烧纸都不是正圆——正圆读起来像"传送门"，
// 边缘有起伏的洞才像自然发生的事。形状用固定种子生成（每次构建都一样），
// 羽化用 SVG 高斯模糊烤进图片里，运行时只有 mask-size 在变。
//
// 两个方向各一张：
//   forward —— 白洞（中心实、外圈透明）：尺寸由小到大 = 新画面从中心长出来；
//   back    —— 反相（中心透明、外圈实）：尺寸由大到小 = 新画面从四周合拢，
//              旧画面被挤回中心。层级向上（返回）时用它。

const SIZE = 200; // viewBox 边长
const C = SIZE / 2;

// 固定种子伪随机（mulberry32）：形状要每次一致，不能每次刷新都变。
function rand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成一条闭合的不规则曲线：极角均匀，半径带低频起伏（像被烧出来的边）。 */
function blobPath(points = 19, seed = 20261018): string {
  const rnd = rand(seed);
  const radii: number[] = [];
  for (let i = 0; i < points; i++) {
    // 半径在 0.62~0.94 之间起伏，叠加一点高频抖动让边缘不平滑
    radii.push(0.5 + rnd() * 0.36 + (rnd() - 0.5) * 0.14);
  }
  const pt = (i: number): [number, number] => {
    const a = (i / points) * Math.PI * 2;
    const r = radii[((i % points) + points) % points] * C;
    return [C + Math.cos(a) * r, C + Math.sin(a) * r];
  };
  // 用二次贝塞尔穿过相邻点中点，得到平滑但起伏的闭合轮廓
  const seg: string[] = [];
  const mid = (i: number): [number, number] => {
    const [x1, y1] = pt(i);
    const [x2, y2] = pt(i + 1);
    return [(x1 + x2) / 2, (y1 + y2) / 2];
  };
  const [sx, sy] = mid(points - 1);
  seg.push(`M${sx.toFixed(1)},${sy.toFixed(1)}`);
  for (let i = 0; i < points; i++) {
    const [px, py] = pt(i);
    const [mx, my] = mid(i);
    seg.push(
      `Q${px.toFixed(1)},${py.toFixed(1)} ${mx.toFixed(1)},${my.toFixed(1)}`,
    );
  }
  seg.push("Z");
  return seg.join(" ");
}

const path = blobPath();

function uri(svg: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** forward：白洞，四周透明——尺寸放大即"从中心漫开"。 */
export const blobForward = uri(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<defs><filter id="f" x="-20%" y="-20%" width="140%" height="140%">` +
    `<feGaussianBlur stdDeviation="7"/></filter></defs>` +
    `<path d="${path}" fill="#fff" filter="url(#f)"/></svg>`,
);
