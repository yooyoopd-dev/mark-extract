/** 토스트. design/index.html 에서 옮겼다. */
import { esc, icon } from "../markdown.js";

let host: HTMLElement | null = null;

export function initToasts(element: HTMLElement): void {
  host = element;
}

export function toast(message: string, kind: "ok" | "err" = "ok"): void {
  if (!host) return;

  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === "ok" ? "i-check" : "i-alert", "icon icon-sm")}<span>${esc(message)}</span>`;
  host.appendChild(el);

  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 200);
  }, 2600);
}
