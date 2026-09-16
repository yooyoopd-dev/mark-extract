/**
 * 골격 단계의 렌더러. 테마 전환만 한다.
 *
 * 원본(design/index.html)의 토큰 구조를 그대로 쓴다 — 명시적으로 고른 테마는
 * data-theme 로 박고, 시스템 설정을 따를 때는 속성을 지워 prefers-color-scheme 에
 * 맡긴다.
 */
type Theme = "system" | "light" | "dark";

const root = document.documentElement;
const button = document.getElementById("themeToggle") as HTMLButtonElement;
const label = document.getElementById("themeLabel") as HTMLSpanElement;

function prefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function apply(theme: Theme): void {
  if (theme === "system") delete root.dataset["theme"];
  else root.dataset["theme"] = theme;

  const dark = theme === "dark" || (theme === "system" && prefersDark());
  label.textContent = dark ? "라이트 모드" : "다크 모드";
  button.setAttribute("aria-pressed", String(dark));
}

let current: Theme = "system";
apply(current);

button.addEventListener("click", () => {
  const dark = current === "dark" || (current === "system" && prefersDark());
  current = dark ? "light" : "dark";
  apply(current);
});

// 스모크 테스트가 테마를 직접 지정할 수 있게 열어 둔다 (모듈 스코프라 이 노출이 없으면
// 바깥에서 닿지 못한다). 설정 영속화는 6단계에서 들어온다.
(window as unknown as { setTheme(theme: Theme): void }).setTheme = apply;
