/**
 * 문서 목록. design/index.html 의 renderList 에서 출발했다.
 *
 * build.36 에서 카드를 줄였다. 이름과 상태가 첫 줄, 형식·크기·시각이 둘째 줄이다.
 * 미리보기 두 줄은 뺐다 — 본문은 바로 옆 뷰어에 있다. 실패한 문서만 사유 한 줄을
 * 남긴다. 그것은 뷰어를 열기 전에 알아야 하는 것이다.
 */
import { icon, esc } from "../markdown.js";
import { counts, KIND_LABEL, needsOcr, STATUS, state, visibleDocs, type Doc } from "../state.js";
import { isUnsaved } from "./editor.js";

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

/** 이미지 PDF 는 빨간 실패가 아니다 (build.37). */
const OCR_NEEDED = { label: "OCR 필요", icon: "i-image", cls: "warn" } as const;

function card(doc: Doc): string {
  const ocr = needsOcr(doc);
  const status = ocr ? OCR_NEEDED : STATUS[doc.status];
  return `
    <button class="doc" role="option" data-id="${doc.id}" aria-selected="${state.selected === doc.id}" tabindex="-1">
      <div class="doc-top">
        <span class="doc-name od-truncate">${isUnsaved(doc) ? '<b class="unsaved" title="저장하지 않음">●</b> ' : ""}${esc(doc.name)}</span>
        <span class="status ${status.cls}">${icon(status.icon, "icon icon-sm")}<span>${status.label}</span></span>
      </div>
      <div class="doc-meta">${KIND_LABEL[doc.kind]} · ${sizeLabel(doc.size)} · ${timeLabel(doc.addedAt)}</div>
      ${
        ocr
          ? `<p class="doc-note od-truncate">이미지로 된 PDF — OCR 로 글자를 읽을 수 있습니다</p>`
          : doc.status === "failed"
            ? `<p class="doc-error od-truncate">${esc(doc.snippet)}</p>`
            : ""
      }
      ${doc.status === "run" ? `<span class="bar"><i data-progress="${doc.progress ?? 0}"></i></span>` : ""}
    </button>`;
}

/** 칩 옆 숫자. 0 이면 비워 둔다 — "실패 0" 은 읽을 거리가 아니다. */
function paintCounts(): void {
  const c = counts();
  for (const el of document.querySelectorAll<HTMLElement>(".chip [data-count]")) {
    const n = c[el.dataset["count"] as keyof typeof c];
    el.textContent = n > 0 ? String(n) : "";
  }
}

export function renderList(host: HTMLElement): void {
  paintCounts();

  const list = visibleDocs();
  if (list.length === 0) {
    const searching = state.query.trim() !== "" || state.status !== "all";
    host.innerHTML = `
      <div class="empty">
        <p class="empty-title">${searching ? "조건에 맞는 문서가 없습니다" : "아직 문서가 없습니다"}</p>
        <p class="empty-sub">${
          searching
            ? "검색어나 상태 필터를 바꿔 보세요."
            : "파일을 이 창에 끌어다 놓으세요. PDF · DOCX · XLSX · XLS · PPTX · HTML · EML 을 Markdown 으로 바꾸고, MD 는 바로 열어 고칩니다."
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
