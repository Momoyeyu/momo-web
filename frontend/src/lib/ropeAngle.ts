// RoPE 角度通道：App 在路由变化时写入"被离开页面的角度"，
// 新页挂载时读走，让自己的网格从 from 角转到本页角——跨页的旋转才成立
// （各页的 GridBackdrop 都是独立画布，互相不知道对方的角度）。
let fromAngle = 0;

export function setRopeFrom(a: number): void {
  fromAngle = a;
}

export function ropeFrom(): number {
  return fromAngle;
}
