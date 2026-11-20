/**
 * 메인 뷰어. design/index.html 의 renderViewer 를 옮겼다.
 *
 * 3번째 탭은 원본의 '추출 필드' 대신 '변환 로그'다 (결정 11). 사내망 PC 는 로그
 * 파일을 반출할 수 없어 이 탭이 유일한 자가진단 수단이므로 전체 복사 버튼을 둔다.
 */
import { esc, highlightMarkdown, icon, renderMarkdown } from "../markdown.js";
import { isDirty, KIND_LABEL, markdown, needsOcr, state, type Doc } from "../state.js";

function emptyPanel(): string {
  return `
    <div class="empty">
      ${icon("i-files", "icon")}
      <p class="empty-title">문서를 선택하세요</p>
      <p class="empty-sub">목록에서 고르거나 파일을 끌어다 놓으세요.</p>
    </div>`;
}

/** OCR 서버를 켜는 중이면 경과와 서버가 마지막으로 찍은 줄. 첫 실행은 몇 분 걸린다. */
function ocrStarting(): string {
  const ocr = state.ocr;
  if (ocr.phase !== "starting") return "";
  const elapsed = ocr.since === undefined ? "" : ` · ${elapsedLabel(ocr.since)}`;
  return `
    <p class="run-detail">OCR 서버를 켜는 중${esc(elapsed)} — 처음에는 모델을 내려받느라 몇 분 걸릴 수 있습니다.</p>
    ${ocr.lastLine ? `<p class="run-line od-truncate">${esc(ocr.lastLine)}</p>` : ""}`;
}

/**
 * 이미지로 된 PDF (build.37). 빨간 실패 상자가 아니라 다음 할 일 하나를 보인다.
 * 버튼은 서버가 꺼져 있어도 누를 수 있다 — main 이 서버를 켜고 준비되면 변환한다.
 */
function needsOcrPanel(): string {
  return `
    <div class="ocrbox">
      ${icon("i-image", "icon")}
      <h2>이미지로 된 PDF 입니다</h2>
      <p>이 PDF 에는 글자 레이어가 없어 바로 읽을 수 없습니다. OCR 로 그림 속 글자를 읽을 수 있습니다.</p>
      <button class="btn primary" data-retry="retry-with-ocr">${icon("i-refresh", "icon icon-sm")}<span>OCR 로 변환</span></button>
      <p class="ocrbox-sub">${
        state.ocr.phase === "on"
          ? "OCR 서버가 켜져 있습니다."
          : "OCR 서버가 꺼져 있으면 자동으로 켭니다. 스캔 쪽이 많으면 몇 분 걸립니다."
      }</p>
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
        ${button("open-ocr-settings", "OCR 설정 열기", true)}
        ${button("retry-with-ocr", "OCR 을 켜고 재시도", true)}
        ${button("retry-with-password", "암호를 입력하고 재시도", true)}
        ${button("retry-mode-b", "로컬 파싱으로 재시도", true)}
        ${button("retry-plain", "그대로 재시도")}
        <button class="btn" id="copyLog">${icon("i-copy", "icon icon-sm")}<span>로그 복사</span></button>
      </div>
    </div>`;
}

/** 인라인 style 이 CSP 에 막혀 있어 폭은 렌더 뒤에 넣는다 (list.ts 와 같다). */
function applyProgress(host: HTMLElement): void {
  for (const fill of host.querySelectorAll<HTMLElement>(".bar > i[data-progress]")) {
    fill.style.width = `${fill.dataset["progress"] ?? 0}%`;
  }
}

function elapsedLabel(since: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (seconds < 60) return `${seconds}초`;
  return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}

/**
 * 변환 중에 무슨 일이 벌어지고 있는지 보인다.
 *
 * 이것이 없으면 느린 것과 멈춘 것을 구별할 수 없다 — build.8 실측에서 Ollama
 * 14B 모델이 "변환하는 중입니다"에서 끝나지 않는 것처럼 보인 이유다. LLM 은
 * 총량을 모르므로 퍼센트를 지어내지 않고 받은 글자 수와 경과 시간을 보인다.
 */
function runningDetail(doc: Doc): string {
  const elapsed = doc.startedAt === undefined ? "" : elapsedLabel(doc.startedAt);

  if (doc.progress !== undefined) {
    return `
      <p class="run-detail">${doc.progress}% · ${esc(elapsed)}</p>
      <span class="bar run-bar"><i data-progress="${doc.progress}"></i></span>`;
  }

  if (doc.chars !== undefined && doc.chars > 0) {
    return `<p class="run-detail">${doc.chars.toLocaleString("ko-KR")}자 받음 · ${esc(elapsed)}</p>`;
  }

  // OCR 을 켠 문서는 서버가 준비될 때까지 기다린다. 그동안 무엇을 기다리는지 보인다.
  if (doc.options.ocr === true && state.ocr.phase === "starting") return ocrStarting();

  // 아직 한 글자도 오지 않았다. LLM 은 모델을 올리는 동안 아무것도 내놓지 않는다.
  return `<p class="run-detail">${elapsed === "" ? "시작하는 중…" : `${esc(elapsed)} 경과 · 첫 응답을 기다리는 중`}</p>`;
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
  dirtyBar: HTMLElement,
  doc: Doc | null,
): void {
  // 일부 쪽만 그림뿐인 PDF (build.37). 변환은 됐으니 결과 위에 띠로만 알린다.
  const bare = doc?.status === "done" ? doc.result?.warnings.find((w) => w.code === "IMAGE_ONLY_PAGES") : undefined;
  dirtyBar.innerHTML =
    (doc && isDirty(doc)
      ? `<div class="dirty">
          ${icon("i-alert", "icon icon-sm")}
          <span>추출 옵션이 변경되었습니다. 결과에 반영하려면 재변환하세요.</span>
          <button class="btn-mini" id="dirtyRun">재변환</button>
        </div>`
      : "") +
    (bare
      ? `<div class="notice">
          ${icon("i-image", "icon icon-sm")}
          <span>${esc(bare.message)}</span>
          <button class="btn-mini" data-retry="retry-with-ocr">OCR 로 다시 변환</button>
        </div>`
      : "");

  if (!doc) {
    crumbs.innerHTML = "";
    warnCount.textContent = "";
    panel.innerHTML = emptyPanel();
    return;
  }

  // 형식 뒤의 꺾쇠(⌄)는 눌러도 아무 일이 없는 장식이었다. 이름과 형식만 둔다.
  crumbs.innerHTML = `<b class="cur" title="${esc(doc.name)}">${esc(doc.name)}</b><span class="seg">${KIND_LABEL[doc.kind]}</span>`;
  const warnings = doc.result?.warnings.length ?? 0;
  warnCount.textContent = warnings > 0 ? String(warnings) : "";

  if (needsOcr(doc)) {
    panel.innerHTML = needsOcrPanel();
    return;
  }

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
        ${doc.status === "run" ? runningDetail(doc) : ""}
        <button class="btn" id="cancelRun">${icon("i-x", "icon icon-sm")}<span>취소</span></button>
      </div>`;
    applyProgress(panel);
    return;
  }

  if (state.tab === "log") {
    panel.innerHTML = logPanel(doc);
    return;
  }

  // 본문은 스냅샷에 없다. doc:markdown 으로 따로 받아 둔 것을 쓴다.
  const body = markdown();
  if (body === "") {
    panel.innerHTML = `<div class="empty">${icon("i-loader", "icon")}<p class="empty-sub">본문을 불러오는 중…</p></div>`;
    return;
  }

  if (state.tab === "source") {
    panel.innerHTML = `<pre class="source"><code>${highlightMarkdown(body)}</code></pre>`;
    return;
  }

  panel.innerHTML = `<article class="reading"><div class="reading-inner">${renderMarkdown(body)}</div></article>`;
}
