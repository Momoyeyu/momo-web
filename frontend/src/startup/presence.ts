type Language = "zh" | "en" | "ja";
type Stage = "connecting" | "restoring" | "ready" | "error";
const copy = {
  zh: {
    connecting: "正在准备和你见面", restoring: "正在找回相处的片刻", ready: "准备好了", error: "这次见面还没准备好",
    note: "启动暂时没有完成。可以重试，或稍后再打开。", retry: "再试一次",
  },
  en: {
    connecting: "Getting ready to meet you", restoring: "Bringing our moments back", ready: "Ready when you are", error: "Couldn’t finish getting ready",
    note: "Please try again, or close the window and come back later.", retry: "Try again",
  },
  ja: {
    connecting: "会う準備をしています", restoring: "一緒に過ごした時間を読み込んでいます", ready: "準備ができました", error: "準備がまだ終わっていません",
    note: "もう一度試すか、ウィンドウを閉じて後で開いてください。", retry: "もう一度",
  },
};

/** The static HTML is already visible before this module or React can run. */
export function startupPresence() {
  const screen = document.getElementById("startup");
  const root = document.getElementById("root");
  const message = screen?.querySelector<HTMLElement>(".startup-message");
  const note = screen?.querySelector<HTMLElement>(".startup-error-note");
  const actions = screen?.querySelector<HTMLElement>(".startup-actions");
  const retry = screen?.querySelector<HTMLButtonElement>("[data-startup-retry]");
  let language: Language = "zh";
  let phase: Stage = "connecting";
  let completed = false;
  let removeTimer: ReturnType<typeof setTimeout> | undefined;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const update = () => {
    if (!screen || completed) return;
    document.documentElement.lang = language === "zh" ? "zh-CN" : language;
    screen.dataset.stage = phase;
    if (message) {
      message.textContent = copy[language][phase];
      message.setAttribute("role", phase === "error" ? "alert" : "status");
      message.setAttribute("aria-live", phase === "error" ? "assertive" : "polite");
    }
    if (note) { note.textContent = copy[language].note; note.hidden = phase !== "error"; }
    if (actions) actions.hidden = phase !== "error";
    if (retry) retry.textContent = copy[language].retry;
  };
  if (retry) retry.onclick = () => { retry.disabled = true; location.reload(); };
  const remove = () => {
    clearTimeout(removeTimer);
    screen?.removeEventListener("transitionend", transitionEnd);
    screen?.remove();
    root?.removeAttribute("inert");
    root?.removeAttribute("aria-hidden");
    root?.removeAttribute("aria-busy");
    release();
  };
  const transitionEnd = (event: TransitionEvent) => {
    if (event.target === screen && event.propertyName === "opacity") remove();
  };
  return {
    ready,
    language(value: string) { language = value === "en" || value === "ja" ? value : "zh"; update(); },
    stage(value: Exclude<Stage, "ready" | "error">) { if (phase !== "error") { phase = value; update(); } },
    fail() {
      if (completed) return;
      phase = "error";
      root?.setAttribute("inert", "");
      update();
    },
    finish() {
      // React StrictMode may run the mount effect twice; neither timers nor screens duplicate.
      if (completed || phase === "error") return;
      phase = "ready";
      update();
      completed = true;
      if (!screen) { remove(); return; }
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) { remove(); return; }
      // Establish the opaque style even on a very fast first mount.
      void getComputedStyle(screen).opacity;
      screen.addEventListener("transitionend", transitionEnd);
      screen.dataset.state = "leaving";
      // A bounded fallback handles a hidden window or a transition that never emits an event.
      removeTimer = setTimeout(remove, 900);
    },
  };
}
