/** 중앙 문서 목록. design/index.html 의 renderList 를 옮겼다. */
import { icon, esc } from "../markdown.js";
import { KIND_LABEL, STATUS, state, viewDef, visibleDocs, type Doc } from "../state.js";

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function timeLabel(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return "방금 전";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  return new Date(at).toLocaleDateString("ko-KR");
}

function card(doc: Doc): string {
  const status = STATUS[doc.status];
  return `
    <button class="doc" role="option" data-id="${doc.id}" aria-selected="${state.selected === doc.id}" tabindex="-1">
      <div class="doc-top">
        <span class="badge ${doc.kind}">${KIND_LABEL[doc.kind]}</span>
        <span class="doc-name od-truncate">${esc(doc.name)}</span>
        ${doc.star ? `<span class="doc-star">${icon("i-star", "icon icon-sm")}</span>` : ""}
      </div>
      <p class="doc-snip od-clamp-2">${esc(doc.snippet)}</p>
      <div class="doc-foot">
        <span class="status ${status.cls}">${icon(status.icon, "icon icon-sm")}<span>${status.label}</span></span>
        <span class="doc-meta">${sizeLabel(doc.size)}</span>
        <span class="doc-meta doc-time">${timeLabel(doc.addedAt)}</span>
      </div>
      ${doc.status === "run" ? `<span class="bar"><i data-progress="${doc.progress ?? 0}"></i></span>` : ""}
    </button>`;
}

export function renderList(host: HTMLElement, title: HTMLElement): void {
  title.textContent = viewDef(state.view).title;

  const list = visibleDocs();
  if (list.length === 0) {
    const searching = state.query.trim() !== "" || state.status !== "all";
    host.innerHTML = `
      <div class="empty">
        ${icon(searching ? "i-search" : "i-inbox", "icon")}
        <p class="empty-title">${searching ? "조건에 맞는 문서가 없습니다" : "아직 문서가 없습니다"}</p>
        <p class="empty-sub">${
          searching ? "검색어나 상태 필터를 바꿔 보세요." : "PDF · DOCX · XLSX · XLS · PPTX 를 끌어다 놓으세요."
        }</p>
        <button class="btn" id="emptyAction">${searching ? "필터 초기화" : "파일 추가"}</button>
      </div>`;
    return;
  }

  host.innerHTML = list.map(card).join("");

  // 진행률은 style 속성으로 줄 수 없다 — CSP 가 style-src 'self' 라 인라인 style
  // 이 막힌다 (원본은 style="width:N%" 를 썼다). 렌더 뒤에 직접 넣는다.
  for (const fill of host.querySelectorAll<HTMLElement>(".bar > i[data-progress]")) {
    fill.style.width = `${fill.dataset["progress"] ?? 0}%`;
  }
}
