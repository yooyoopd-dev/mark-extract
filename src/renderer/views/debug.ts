/**
 * 2단계 디버그 화면 — PDF 를 떨어뜨려 변환 결과와 로그를 본다.
 *
 * Windows 에서 동작을 확인할 방법이 필요해서 둔 임시 화면이다. 본 뷰어는
 * 로드맵 4단계에서 만들며 이 파일은 그때 통째로 교체된다.
 */
import type { ParseResult } from "../../shared/parse";

const EMPTY = "PDF 파일을 이 영역에 떨어뜨리세요.";

export function mountDebugView(host: HTMLElement): void {
  host.innerHTML = `
    <div class="dbg" id="dbgDrop">
      <p class="dbg-hint" id="dbgHint">${EMPTY}</p>
      <div class="dbg-panes" id="dbgPanes" hidden>
        <pre class="dbg-md" id="dbgMd"></pre>
        <div class="dbg-log" id="dbgLog"></div>
      </div>
    </div>`;

  const drop = host.querySelector<HTMLElement>("#dbgDrop")!;
  const hint = host.querySelector<HTMLElement>("#dbgHint")!;
  const panes = host.querySelector<HTMLElement>("#dbgPanes")!;
  const md = host.querySelector<HTMLElement>("#dbgMd")!;
  const log = host.querySelector<HTMLElement>("#dbgLog")!;

  const show = (result: ParseResult) => {
    md.textContent = result.ok ? result.markdown : (result.error?.message ?? "변환에 실패했습니다.");
    md.dataset["state"] = result.ok ? "ok" : "error";

    const rows = [
      ...result.log.map((e) => [e.label, e.value] as const),
      ["경고", String(result.warnings.length)],
      ...result.warnings.map((w) => [`  ${w.code}`, w.message] as const),
    ];
    log.innerHTML = rows
      .map(([k, v]) => `<div class="dbg-row"><span>${esc(k)}</span><code>${esc(v)}</code></div>`)
      .join("");
    panes.hidden = false;
  };

  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.dataset["over"] = "true";
  });
  drop.addEventListener("dragleave", () => delete drop.dataset["over"]);

  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    delete drop.dataset["over"];

    const file = event.dataTransfer?.files[0];
    if (!file) return;

    // sandbox 렌더러에는 File.path 가 없다. preload 의 webUtils 를 거친다.
    const path = window.markExtract.getFilePath(file);
    hint.textContent = `변환 중… ${file.name}`;
    panes.hidden = true;

    void window.markExtract
      .convert(path)
      .then((result) => {
        hint.textContent = file.name;
        show(result);
      })
      .catch((error: unknown) => {
        hint.textContent = EMPTY;
        md.textContent = error instanceof Error ? error.message : String(error);
        md.dataset["state"] = "error";
        panes.hidden = false;
      });
  });
}

function esc(value: string): string {
  return value.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
}
