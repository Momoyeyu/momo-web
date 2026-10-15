// 极简 hash 路由：#/title | #/chat | #/settings | #/backlog | #/sessions。

import { useSyncExternalStore } from "react";

type Route = "title" | "chat" | "settings" | "backlog" | "sessions";

/** 存档页模式：标题菜单「存档/读档」入口分别落到 save / load。 */
export type SessionsMode = "save" | "load";

const ROUTES: readonly Route[] = [
  "title",
  "chat",
  "settings",
  "backlog",
  "sessions",
];

function currentRoute(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  return (ROUTES as readonly string[]).includes(h) ? (h as Route) : "title";
}

/** 路由跳转前的来源页（仅记录编程式 navigate；直改 hash 时回落 title）。 */
let from: Route | null = null;
/** 进入存档页的目标模式（hash 无参数机制，走模块态通道；直开 #/sessions 默认读档）。 */
let sessionsMode: SessionsMode = "load";

export function navigate(
  route: Route,
  opts?: { sessionsMode?: SessionsMode },
): void {
  if (route === "sessions" && opts?.sessionsMode) {
    sessionsMode = opts.sessionsMode;
  }
  from = currentRoute();
  window.location.hash = `#/${route}`;
}

/** 当前页是从哪一页跳进来的（如 settings 区分「返回标题/返回对话」）。 */
export function fromRoute(): Route {
  return from ?? "title";
}

/** 存档页本次进入的模式（由入口在 navigate 时指定）。 */
export function sessionsEntryMode(): SessionsMode {
  return sessionsMode;
}

function subscribeHash(fn: () => void): () => void {
  window.addEventListener("hashchange", fn);
  return () => window.removeEventListener("hashchange", fn);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribeHash, currentRoute);
}
