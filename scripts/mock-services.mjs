// 本地冒烟用 mock：LLM(SSE) + TTS(PCM 静音) 合一，端口 5399。
// 只用于手工/浏览器冒烟验证，不是产品代码。
import { createServer } from "node:http";

const sse = (lines) =>
  lines.map((l) => `data: ${l}\n\n`).join("") + "data: [DONE]\n\n";

const chunk = (text) =>
  JSON.stringify({
    choices: [{ delta: { content: text }, index: 0 }],
  });

const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type,authorization");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url?.includes("chat/completions")) {
      const isExtract = body.includes("JSON") && body.includes("op");
      const reply = isExtract
        ? '[{"op":"add","kind":"semantic","content":"用户喜欢做冒烟测试"}]'
        : "[happy] 欸，你来啦！[neutral] 让我想想今天聊点什么好呢，嗯……其实我有好多话想跟你说，你听我说完嘛。";
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const parts = reply.match(/.{1,4}/gs) ?? [reply];
      let i = 0;
      const tick = () => {
        if (i < parts.length) {
          res.write(`data: ${chunk(parts[i++])}\n\n`);
          setTimeout(tick, 250);
        } else {
          res.end("data: [DONE]\n\n");
        }
      };
      tick();
      res.on("close", () => {
        i = parts.length; // 客户端断连（barge-in 取消）→ 停写
      });
      return;
    }
    if (req.url?.includes("audio/speech")) {
      // 0.8s PCM s16le 24kHz mono 静音（38400B）
      const pcm = Buffer.alloc(38400);
      res.writeHead(200, { "content-type": "audio/pcm" });
      res.end(pcm);
      return;
    }
    res.writeHead(404).end("{}");
  });
});
server.listen(5399, "127.0.0.1", () => console.log("mock on :5399"));
