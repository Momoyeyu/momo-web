// 极简 hash 路由：#/title | #/chat | #/settings | #/backlog | #/checkpoint。

import { useSyncExternalStore } from "react";

export type Route = "title" | "chat" | "settings" | "backlog" | "checkpoint";

/** 存档页模式：入口决定（对话工具条「存档/读档」、标题菜单「读档」）。 */
export type CheckpointMode = "save" | "load";

const ROUTES: readonly Route[] = [
  "title",
  "chat",
  "settings",
  "backlog",
  "checkpoint",
];

function currentRoute(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  return (ROUTES as readonly string[]).includes(h) ? (h as Route) : "title";
}

/** 路由跳转前的来源页（仅记录编程式 navigate；直改 hash 时回落 title）。 */
let from: Route | null = null;
/** 进入存档页的目标模式（hash 无参数机制，走模块态通道；直开 #/checkpoint 默认读档）。 */
let checkpointMode: CheckpointMode = "load";

export function navigate(
  route: Route,
  opts?: { checkpointMode?: CheckpointMode },
): void {
  if (route === "checkpoint" && opts?.checkpointMode) {
    checkpointMode = opts.checkpointMode;
  }
  from = currentRoute();
  window.location.hash = `#/${route}`;
}

/** 当前页是从哪一页跳进来的（如 settings 区分「返回标题/返回对话」）。 */
export function fromRoute(): Route {
  return from ?? "title";
}

/** 存档页本次进入的模式（由入口在 navigate 时指定）。 */
export function checkpointEntryMode(): CheckpointMode {
  return checkpointMode;
}

function subscribeHash(fn: () => void): () => void {
  window.addEventListener("hashchange", fn);
  return () => window.removeEventListener("hashchange", fn);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribeHash, currentRoute);
}
