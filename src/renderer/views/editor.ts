/**
 * md 편집기 (build.38).
 *
 * 텍스트 영역 하나와, 넓은 창이면 그 옆의 미리보기다. WYSIWYG 는 하지 않는다 —
 * 입력 중인 블록을 다시 그리는 편집기는 커서와 한글 IME 조합을 따로 다뤄야 한다.
 * 텍스트 영역은 그 둘과 실행 취소를 브라우저가 맡는다.
 *
 * **편집 영역은 다시 그리지 않는다.** 뷰어는 목록이 바뀔 때마다 innerHTML 로 새로
 * 그린다. 편집 영역이 그 안에 있으면 변환 진행 이벤트 하나에 커서와 실행 취소 기록이
 * 날아간다. 그래서 index.html 에 고정으로 두고 값만 맞춘다.
 *
 * 고친 내용은 저장할 때까지 렌더러에만 있다 (`edits`). main 에는 그 개수만 알린다 —
 * 창을 닫을 때 물어보는 데 쓴다.
 */
import type { Doc } from "../state.js";

/** 저장한 것과 다른 본문. 같아지면 지운다 — 되돌려 쓰면 ● 가 사라진다. */
export const edits = new Map<string, string>();

const PREVIEW_DELAY_MS = 150;

const editor = document.querySelector<HTMLElement>("#editor")!;
const text = document.querySelector<HTMLTextAreaElement>("#editText")!;
const preview = document.querySelector<HTMLElement>("#editPreview")!;

/** 지금 편집 영역에 실린 문서와 그 문서의 저장본 */
let current: { id: string; saved: string } | null = null;
let timer: number | null = null;
let onChange: () => void = () => undefined;

export const isUnsaved = (doc: Doc): boolean => edits.has(doc.id);

/** 화면에 보이는(저장 전이면 고친) 본문 */
export const currentText = (doc: Doc, saved: string): string => edits.get(doc.id) ?? saved;

/* ── 미리보기 HTML 캐시 ──────────────────────────────── */

let cache: { src: string; html: string } | null = null;
let inflight: string | null = null;

/**
 * 미리보기 HTML. main 이 그리므로 비동기다 — 캐시에 없으면 null 을 주고 받아 오며,
 * 받으면 `ready` 를 부른다.
 */
export function previewHtml(src: string, ready: () => void): string | null {
  if (cache?.src === src) return cache.html;
  if (inflight !== src) {
    inflight = src;
    void window.markExtract.renderMd(src).then((html) => {
      if (inflight !== src) return;
      inflight = null;
      cache = { src, html };
      ready();
    });
  }
  return null;
}

function paintPreview(): void {
  const src = text.value;
  const html = previewHtml(src, paintPreview);
  if (html !== null && text.value === src) preview.innerHTML = `<div class="reading-inner">${html}</div>`;
}

/* ── 편집 영역 ───────────────────────────────────────── */

export function initEditor(changed: () => void): void {
  onChange = changed;

  text.addEventListener("input", () => {
    if (!current) return;
    if (text.value === current.saved) edits.delete(current.id);
    else edits.set(current.id, text.value);
    onChange();

    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      paintPreview();
    }, PREVIEW_DELAY_MS);
  });

  // Tab 은 들여쓰기. 포커스를 다음 요소로 넘기지 않는다. execCommand 로 넣어야
  // 브라우저의 실행 취소 기록에 남는다 (value 를 직접 고치면 Ctrl+Z 가 끊긴다).
  text.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    document.execCommand("insertText", false, "\t");
  });
}

/**
 * 편집 영역을 보이거나 숨긴다. 보일 때는 그 문서의 본문을 싣는다.
 *
 * 같은 문서면 손대지 않는다 — 다시 그릴 때마다 value 를 넣으면 커서가 끝으로 가고
 * 실행 취소 기록이 끊긴다. 저장본이 바뀌었고(다시 읽기) 고친 것이 없을 때만 바꾼다.
 */
export function showEditor(doc: Doc | null, saved: string | null): void {
  const visible = doc !== null && saved !== null;
  editor.hidden = !visible;
  if (!visible) return;

  if (current?.id !== doc.id) {
    text.value = currentText(doc, saved);
    current = { id: doc.id, saved };
    paintPreview();
    return;
  }
  current.saved = saved;
  if (!edits.has(doc.id) && text.value !== saved) {
    text.value = saved;
    paintPreview();
  }
}

/** 저장했다. 편집 영역의 값은 그대로 두고 저장본만 맞춘다. */
export function markSaved(doc: Doc, savedText: string): void {
  edits.delete(doc.id);
  if (current?.id === doc.id) current.saved = savedText;
}

/** 고친 것을 버린다 (다시 읽기 · 목록에서 제거). */
export function discard(id: string): void {
  edits.delete(id);
  if (current?.id === id) current = null;
}

export const focusEditor = (): void => text.focus();
