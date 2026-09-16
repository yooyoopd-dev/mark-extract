/**
 * 메인 뷰어. design/index.html 의 renderViewer 를 옮겼다.
 *
 * 3번째 탭은 원본의 '추출 필드' 대신 '변환 로그'다 (결정 11). 사내망 PC 는 로그
 * 파일을 반출할 수 없어 이 탭이 유일한 자가진단 수단이므로 전체 복사 버튼을 둔다.
 */
import { esc, highlightMarkdown, icon, renderMarkdown } from "../markdown.js";
import { KIND_LABEL, state, type Doc } from "../state.js";

function emptyPanel(): string {
  return `
    <div class="empty">
      ${icon("i-files", "icon")}
      <p class="empty-title">문서를 선택하세요</p>
      <p class="empty-sub">왼쪽 목록에서 고르거나 파일을 끌어다 놓으세요.</p>
    </div>`;
}

function failPanel(doc: Doc): string {
  const error = doc.result?.error;
  const actions = error?.actions ?? [];

  const button = (action: string, label: string, primary = false): string =>
    actions.includes(action as never)
      ? `<button class="btn${primary ? " primary" : ""}" data-retry="${action}">${icon("i-refresh", "icon icon-sm")}<span>${label}</span></button>`
      : "";

  return `
    <div class="failbox">
      <div class="fail-head">${icon("i-alert", "icon")}<h2>변환에 실패했습니다</h2></div>
      <p class="fail-msg">${esc(error?.message ?? "사유를 알 수 없습니다.")}</p>
      <dl>
        <dt>파일</dt><dd>${esc(doc.name)}</dd>
        <dt>코드</dt><dd>${esc(error?.code ?? "-")}</dd>
        <dt>엔진</dt><dd>${esc(doc.result?.meta.engine ?? "-")}</dd>
      </dl>
      <div class="fail-actions">
        ${button("retry-with-ocr", "OCR 을 켜고 재시도", true)}
        ${button("retry-with-password", "암호를 입력하고 재시도", true)}
        ${button("retry-mode-b", "로컬 파싱으로 재시도", true)}
        ${button("retry-plain", "그대로 재시도")}
      </div>
    </div>`;
}

function logPanel(doc: Doc): string {
  const result = doc.result;
  if (!result) return `<div class="empty"><p class="empty-sub">아직 변환하지 않았습니다.</p></div>`;

  const rows = [
    ...result.log.map((e) => [e.label, e.value] as const),
    ["경고", `${result.warnings.length}건`] as const,
    ...result.warnings.map((w) => [`· ${w.code}`, w.message] as const),
  ];

  return `
    <div class="fields">
      <div class="od-row log-head">
        <span class="od-fill log-note">
          사내망에서는 로그 파일을 반출할 수 없으므로 이 탭이 유일한 자가진단 수단입니다.
        </span>
        <button class="btn od-fixed" id="copyLog">${icon("i-copy", "icon icon-sm")}<span>전체 복사</span></button>
      </div>
      <dl class="meta">
        ${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}
      </dl>
    </div>`;
}

export function logText(doc: Doc): string {
  const result = doc.result;
  if (!result) return "";
  return [
    `파일: ${doc.name}`,
    ...result.log.map((e) => `${e.label}: ${e.value}`),
    `경고: ${result.warnings.length}건`,
    ...result.warnings.map((w) => `  [${w.code}] ${w.message}`),
  ].join("\n");
}

export function renderViewer(
  panel: HTMLElement,
  crumbs: HTMLElement,
  warnCount: HTMLElement,
  doc: Doc | null,
): void {
  if (!doc) {
    crumbs.innerHTML = "";
    warnCount.textContent = "";
    panel.innerHTML = emptyPanel();
    return;
  }

  crumbs.innerHTML = `<span>${KIND_LABEL[doc.kind]}</span>${icon("i-chev", "icon icon-sm")}<b>${esc(doc.name)}</b>`;
  const warnings = doc.result?.warnings.length ?? 0;
  warnCount.textContent = warnings > 0 ? String(warnings) : "";

  if (doc.status === "failed") {
    panel.innerHTML = failPanel(doc);
    return;
  }

  if (doc.status !== "done" || !doc.result) {
    panel.innerHTML = `
      <div class="empty">
        ${icon(doc.status === "run" ? "i-loader" : "i-clock", "icon")}
        <p class="empty-title">${doc.status === "run" ? "변환하는 중입니다" : "변환 대기 중"}</p>
        <p class="empty-sub">${esc(doc.name)}</p>
        ${doc.status === "queued" ? `<button class="btn primary" id="runNow">지금 변환 시작</button>` : ""}
      </div>`;
    return;
  }

  if (state.tab === "log") {
    panel.innerHTML = logPanel(doc);
    return;
  }

  if (state.tab === "source") {
    panel.innerHTML = `<pre class="source"><code>${highlightMarkdown(doc.result.markdown)}</code></pre>`;
    return;
  }

  panel.innerHTML = `<article class="reading"><div class="reading-inner">${renderMarkdown(doc.result.markdown)}</div></article>`;
}
