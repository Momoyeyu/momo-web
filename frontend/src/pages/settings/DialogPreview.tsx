

// 设置页的对话框实时预览：多句循环，逐字上屏 + 按切句速度换句。
// 切句用本文件旁边的 dialogPreviewSplit —— 真实对话的切句在后端。
import { useEffect, useState } from "react";
import { SentenceSplitter } from "../dialogPreviewSplit";
import { charsPerSec, dwellMs, sentencePauseMs } from "../../chat/pacing";
import { useT } from "../../i18n";
import DialogBox from "../../components/DialogBox";
/**
 * 对话框预览：与 chat 同一套节奏换算——按文字速度逐字上屏、
 * 按切句速度驻留+停顿，多句循环播放（预览无 TTS，走驻留路径）。
 */
export default function DialogPreview({
  name,
  sample,
  opacity,
  textSpeed,
  sentenceSpeed,
  showStatus,
  lang,
}: {
  name: string;
  sample: string;
  opacity: number;
  textSpeed: number;
  sentenceSpeed: number;
  /** 预览也要跟着「显示对话状态」开关（状态条已是对话框本体的一部分）。 */
  showStatus: boolean;
  lang?: string;
}) {
  const t = useT();
  const [text, setText] = useState("");

  useEffect(() => {
    const splitter = new SentenceSplitter();
    const sentences = splitter.push(sample);
    const tail = splitter.flush();
    if (tail) sentences.push(tail);
    if (!sentences.length) return;
    let idx = 0;
    let reveal = 0;
    let doneAt = 0;
    let pausedUntil = 0;
    const timer = window.setInterval(() => {
      const now = performance.now();
      if (now < pausedUntil) return;
      const cur = sentences[idx];
      const rate = charsPerSec(textSpeed);
      reveal =
        rate === Infinity ? cur.length : Math.min(cur.length, reveal + rate * 0.04);
      if (reveal >= cur.length) {
        if (!doneAt) doneAt = now;
        if (now - doneAt >= dwellMs(sentenceSpeed, cur.length)) {
          idx = (idx + 1) % sentences.length;
          reveal = 0;
          doneAt = 0;
          pausedUntil = now + sentencePauseMs(sentenceSpeed);
          return; // 停顿时段保持上一句驻留，不清空
        }
      }
      setText(cur.slice(0, Math.floor(reveal)));
    }, 40);
    return () => window.clearInterval(timer);
  }, [sample, textSpeed, sentenceSpeed]);

  return (
    <div
      className="dialog-preview"
      style={{ "--dialog-alpha": opacity / 100 } as React.CSSProperties}
    >
      <DialogBox
        lang={lang}
        name={name}
        text={text}
        status={
          showStatus ? (
            <div className="chat-status status-idle">
              <span className="dot" />
              {t("chat.idle")}
            </div>
          ) : undefined
        }
      />
    </div>
  );
}

/* ---- 拓展配置弹窗（prototype/setting：居中 modal，背景变暗、点背景丢弃） ---- */
