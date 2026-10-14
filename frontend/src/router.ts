// 极简 hash 路由：#/title | #/chat | #/settings | #/backlog。

import { useSyncExternalStore } from "react";

type Route = "title" | "chat" | "settings" | "backlog";

const ROUTES: readonly Route[] = [
  "title",
  "chat",
  "settings",
  "backlog",
];

function currentRoute(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  return (ROUTES as readonly string[]).includes(h) ? (h as Route) : "title";
}

/** 路由跳转前的来源页（仅记录编程式 navigate；直改 hash 时回落 title）。 */
let from: Route | null = null;

export function navigate(route: Route): void {
  from = currentRoute();
  window.location.hash = `#/${route}`;
}

/** 当前页是从哪一页跳进来的（如 settings 区分「返回标题/返回对话」）。 */
export function fromRoute(): Route {
  return from ?? "title";
}

function subscribeHash(fn: () => void): () => void {
  window.addEventListener("hashchange", fn);
  return () => window.removeEventListener("hashchange", fn);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribeHash, currentRoute);
}
