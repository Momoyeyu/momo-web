# 场景转场

## Chat → Home：玻璃碎裂（2026-11-02 首版，待体验）

Home 点击时取得当前舞台的临时画面，随后正常返回 title、收束激活；真实 title 渲染在碎片背后。不是给画面叠一层通用碎屑：人物、房间、对白和可见手机都属于被切开的纹理。快照仅在内存中使用，完成、取消或被替代后释放，不持久化或上传。

`effects/GlassReturn.tsx` 用单个 Canvas 绘制约 72 块有界 Voronoi 多边形；`lib/glassShatter.ts` 生成可复现几何与重力轨迹。中心局部加密、错峰脱离、向下加速并旋转翻面，裂边有冷白反光。首版选择 940ms，属于实现上的节奏选择，等待维护者体验调整。几何仅计算一次，逐帧不更新 React 状态。

`effects/captureStage.ts` 按需加载锁定的 html-to-image 1.11.13；进入 chat 后预热静态字体，Home 悬停或聚焦也可预热。WebGL 在序列化对应画布前同任务重绘，不永久开启 preserveDrawingBuffer。快照分辨率上限为 1280 宽；准备最多等待 1400ms，失败或超时沿用正常返回，不能锁住玩家。减少动态时直接返回；后台隐藏、窗口缩放或路由改变会结束演出并清理资源。外部强制 hash 导航不等待或重放旧快照。

只给 chat 的 Home 按钮使用：title → chat 保持已验收的 ASCII/方格开场，settings / backlog 的往返保留 RoPE，手机独立显隐也保持 011 的效果。

验证：几何测试检查分区面积完整、随机种子可复现、下落与终点清空；`34-glass-return.spec.ts` 检查真实画面捕获、title 背层、手机打开、缩放、减少动态、快照失败与导航取消，并采集中间帧。浏览器使用隔离合成资料，不调用真实 QQ 或更改玩家配置。

快照依赖与接口说明参考 [html-to-image 官方源码](https://github.com/bubkoo/html-to-image/tree/v1.11.13/src)。本轮仅 Web，尚未验证桌面 WebView 的 SVG foreignObject 栅格化；桌面同步时需单独核验，失败路径始终可以回到 title。
