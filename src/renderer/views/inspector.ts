/**
 * 우측 인스펙터. design/index.html 의 renderInspector 를 옮기되 설계 문서가 정한
 * 개편을 반영한다 (docs/design/04-ui-spec.md).
 *
 *   원본 ocr 토글        → hybrid 서버 연결 시에만 활성 (7단계)
 *   엔진 선택 추가       → 로컬 / LLM (6단계)
 *   chunk 슬라이더 제거  → 출력이 Markdown 전용이라 RAG 청킹이 할 일이 없다
 *
 * 표·이미지 선택지는 실제 어댑터 옵션(--table-method, --image-output)에 맞춘다.
 * 원본의 선택지는 시제품이라 없는 값을 담고 있었다.
 */
import { esc, icon } from "../markdown.js";
import { effectiveOptions, KIND_LABEL, STATUS, type Doc, type DocOptions } from "../state.js";
import type { Provider } from "../../shared/parse";

function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const cell = (term: string, value: string): string =>
  `<div><dt>${esc(term)}</dt><dd>${esc(value)}</dd></div>`;

const sel = (value: string, want: string): string => (value === want ? " selected" : "");

const PROVIDERS: ReadonlyArray<[Provider, string]> = [
  ["claude", "Claude Code"],
  ["gemini", "Gemini CLI"],
  ["codex", "Codex CLI"],
  ["ollama", "Ollama (로컬 모델)"],
];

/**
 * LLM 엔진을 골랐을 때만 나오는 칸.
 *
 * 모델은 자유 입력이다 — CLI 버전마다 받는 이름이 달라 목록을 앱에 박으면 금방
 * 낡는다. Ollama 모델 드롭다운은 설정 화면(6b)에서 /api/tags 로 채운다.
 */
function llmOptions(options: DocOptions): string {
  const provider = options.provider ?? "claude";
  const mode = options.inputMode ?? "B";
  // Ollama 는 파일 읽기 도구가 없어 모드 A 를 할 수 없다.
  const modeA = provider !== "ollama";

  return `
    <div class="opt">
      <label for="optProvider">프로바이더</label>
      <select id="optProvider" data-opt="provider">
        ${PROVIDERS.map(([id, label]) => `<option value="${id}"${sel(provider, id)}>${esc(label)}</option>`).join("")}
      </select>
    </div>
    <div class="opt">
      <label for="optModel">모델</label>
      <input id="optModel" type="text" data-opt="model" value="${esc(options.model ?? "")}"
             placeholder="${provider === "ollama" ? "예: qwen2.5:7b (필수)" : "비우면 CLI 기본값"}">
      <span class="desc">${
        provider === "ollama"
          ? "Ollama 는 모델 이름이 필요합니다. 설치된 모델 이름을 그대로 적으세요."
          : "CLI 가 받는 모델 이름을 그대로 적습니다. 비우면 CLI 기본값을 씁니다."
      }</span>
    </div>
    <div class="opt">
      <label for="optMode">입력 모드</label>
      <select id="optMode" data-opt="inputMode">
        <option value="B"${sel(mode, "B")}>B — 로컬 파싱 후 재가공</option>
        <option value="A"${sel(mode, "A")}${modeA ? "" : " disabled"}>A — CLI 가 파일을 직접 읽음</option>
      </select>
      <span class="desc">${
        !modeA
          ? "Ollama 는 파일 읽기 도구가 없어 모드 A 를 쓸 수 없습니다."
          : mode === "A"
            ? "변환할 파일 1개만 임시 폴더에 복사해 전달하며, 읽기 도구만 허용합니다. 원본 파일의 실제 경로는 전달되지 않습니다."
            : "로컬 파서가 뽑은 Markdown 을 넘겨 구조를 다듬게 합니다. 모든 프로바이더·모든 형식에서 동작합니다."
      }</span>
    </div>`;
}

export function renderInspector(host: HTMLElement, doc: Doc | null): void {
  if (!doc) {
    host.innerHTML = `
      <div class="insp-sec">
        <h3>선택된 문서 없음</h3>
        <p>문서를 선택하면 메타데이터와 추출 옵션이 표시됩니다.</p>
      </div>`;
    return;
  }

  const result = doc.result;
  const status = STATUS[doc.status];
  const unit = doc.kind === "pptx" ? "슬라이드" : doc.kind === "xlsx" || doc.kind === "xls" ? "시트" : "쪽";

  const options = effectiveOptions(doc);
  // 표 감지 방식은 opendataloader 의 --table-method 라서 PDF 에만 있다.
  const pdfOnly = doc.kind === "pdf" ? "" : "disabled";
  const engine = options.engine ?? "local";
  // 스위치는 "제거한다"이고 옵션은 "포함한다"라 서로 반대다.
  const strip = options.includeHeaderFooter !== true;

  host.innerHTML = `
    <div class="insp-sec">
      <h3>문서</h3>
      <div class="od-row insp-doc">
        <span class="fmt lg ${doc.kind} od-fixed" aria-hidden="true">${KIND_LABEL[doc.kind]}</span>
        <span class="od-fill od-truncate insp-doc-name" title="${esc(doc.name)}">${esc(doc.name)}</span>
      </div>
      <dl class="meta">
        ${cell("상태", status.label)}
        ${cell("분량", result?.meta.pages === undefined ? "—" : `${result.meta.pages}${unit}`)}
        ${cell("용량", sizeLabel(doc.size))}
        ${cell("처리 시간", result ? `${(result.meta.elapsedMs / 1000).toFixed(1)}초` : "—")}
        ${cell("경고", result ? `${result.warnings.length}건` : "—")}
        ${cell("엔진", result?.meta.engine ?? "—")}
      </dl>
    </div>

    <div class="insp-sec">
      <h3>변환 엔진</h3>
      <div class="opt">
        <label for="optEngine">처리 방식</label>
        <select id="optEngine" data-opt="engine">
          <option value="local"${sel(engine, "local")}>로컬 엔진</option>
          <option value="llm"${sel(engine, "llm")}>LLM 엔진</option>
        </select>
        <span class="desc">${
          engine === "llm"
            ? "LLM 엔진의 결과는 재현되지 않습니다. 같은 문서를 다시 변환하면 달라질 수 있습니다."
            : "로컬 엔진은 같은 문서에서 항상 같은 결과를 냅니다."
        }</span>
      </div>
      ${engine === "llm" ? llmOptions(options) : ""}
    </div>

    <div class="insp-sec">
      <h3>추출 옵션</h3>
      <div class="switchrow">
        <span class="txt"><b>OCR 사용</b><span>텍스트 레이어가 없는 스캔 문서를 이미지에서 인식. hybrid 서버 연결이 필요합니다 (7단계)</span></span>
        <button class="sw" role="switch" data-opt="ocr" aria-checked="false" aria-label="OCR 사용" disabled></button>
      </div>
      <div class="switchrow insp-switch-last">
        <span class="txt"><b>머리글·바닥글 제거</b><span>반복되는 페이지 번호와 머리글을 본문에서 제외</span></span>
        <button class="sw" role="switch" data-opt="strip" aria-checked="${strip}" aria-label="머리글 바닥글 제거"></button>
      </div>
      <div class="opt">
        <label for="optTables">표 감지 방식</label>
        <select id="optTables" data-opt="tableMethod" ${pdfOnly}>
          <option value="default"${sel(options.tableMethod ?? "default", "default")}>테두리 기반</option>
          <option value="cluster"${sel(options.tableMethod ?? "default", "cluster")}>테두리 + 군집</option>
        </select>
        <span class="desc">테두리가 없는 표가 많은 문서는 군집 방식이 더 잘 잡습니다. PDF 전용입니다.</span>
      </div>
      <div class="opt">
        <label for="optImages">이미지 처리</label>
        <select id="optImages" data-opt="imageOutput">
          <option value="external"${sel(options.imageOutput ?? "external", "external")}>파일로 참조</option>
          <option value="embedded"${sel(options.imageOutput ?? "external", "embedded")}>본문에 포함</option>
          <option value="off"${sel(options.imageOutput ?? "external", "off")}>제외</option>
        </select>
      </div>
      <button class="btn block" id="inspReconvert">${icon("i-refresh", "icon icon-sm")}<span>이 설정으로 재변환</span></button>
    </div>

    <div class="insp-sec">
      <h3>내보내기</h3>
      <div class="od-stack insp-actions">
        <button class="btn block primary" id="inspExport" ${doc.status === "done" ? "" : "disabled"}>
          ${icon("i-down", "icon icon-sm")}<span>Markdown 내보내기</span></button>
        <button class="btn block" id="inspCopy" ${doc.status === "done" ? "" : "disabled"}>
          ${icon("i-copy", "icon icon-sm")}<span>클립보드에 복사</span></button>
      </div>
    </div>`;
}
