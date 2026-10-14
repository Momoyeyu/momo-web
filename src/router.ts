// 极简 hash 路由：#/title | #/chat | #/settings | #/backlog。

import { useSyncExternalStore } from "react";

export type Route = "title" | "chat" | "settings" | "backlog";

const ROUTES: readonly Route[] = [
  "title",
  "chat",
  "settings",
  "backlog",
];

export function currentRoute(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  return (ROUTES as readonly string[]).includes(h) ? (h as Route) : "title";
}

export function navigate(route: Route): void {
  window.location.hash = `#/${route}`;
}

function subscribeHash(fn: () => void): () => void {
  window.addEventListener("hashchange", fn);
  return () => window.removeEventListener("hashchange", fn);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribeHash, currentRoute);
}
