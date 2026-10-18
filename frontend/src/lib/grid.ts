// 全局网格底纹：标题页（EcgCanvas）与设置页（GridBackdrop）共用同一把标尺。
// 28px 细格 + 140px 粗格，暖白极淡——监护仪的坐标纸质感。
// 调用方负责坐标变换（dpr / 旋转 / 平移），本函数只画线。

export const GRID_MINOR = 28;
export const GRID_MAJOR = 140;

export function drawGrid(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  contrast = 1,
): void {
  ctx.lineWidth = 1;
  ctx.strokeStyle = `rgba(243,236,223,${0.028 * contrast})`;
  ctx.beginPath();
  for (let x = 0; x <= w; x += GRID_MINOR) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
  }
  for (let y = 0; y <= h; y += GRID_MINOR) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
  }
  ctx.stroke();

  ctx.strokeStyle = `rgba(243,236,223,${0.055 * contrast})`;
  ctx.beginPath();
  for (let x = 0; x <= w; x += GRID_MAJOR) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
  }
  for (let y = 0; y <= h; y += GRID_MAJOR) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
  }
  ctx.stroke();
}
