/** 좌측 내비게이션. design/index.html 의 renderNav 를 옮겼다. */
import { icon, esc } from "../markdown.js";
import { counts, state } from "../state.js";

function item(view: string, iconName: string, label: string, count: number, pill = false): string {
  return `
    <button class="nav-item" role="link" data-view="${view}" aria-current="${state.view === view}">
      ${icon(iconName)}
      <span class="label">${esc(label)}</span>
      ${pill && count > 0 ? `<span class="pill">${count}</span>` : `<span class="count">${count}</span>`}
    </button>`;
}

export function renderSidebar(host: HTMLElement): void {
  const c = counts();

  host.innerHTML = `
    <div class="nav-group">
      ${item("queue", "i-inbox", "변환 큐", c.queue, true)}
      ${item("all", "i-files", "전체 문서", c.all)}
      ${item("done", "i-check", "완료", c.done)}
      ${item("failed", "i-alert", "실패", c.failed)}
      ${item("star", "i-star", "즐겨찾기", c.star)}
    </div>
    <div class="nav-group">
      <div class="nav-head"><span>종류</span></div>
      ${item("kind:pdf", "i-files", "PDF", c.pdf)}
      ${item("kind:docx", "i-files", "Word", c.docx)}
      ${item("kind:xlsx", "i-table", "Excel", c.xlsx)}
      ${item("kind:pptx", "i-image", "PowerPoint", c.pptx)}
    </div>`;
}
