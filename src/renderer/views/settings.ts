/**
 * 설정 화면 (docs/design/04-ui-spec.md#설정-화면).
 *
 * 원본 디자인에 없는 화면이라 원본의 다이얼로그 스타일을 그대로 쓴다.
 *
 * 값은 바꾸는 즉시 저장한다. 확인 버튼을 두지 않는 이유는 여기 있는 것이 전부
 * 되돌릴 수 있는 설정이고, "적용"을 누르지 않아 설정이 안 먹었다고 헤매는 쪽이 더
 * 흔한 실수이기 때문이다.
 */
import { esc, icon } from "../markdown.js";
import type { CliStatus, Settings, WatchFolder } from "../../shared/doc";

export type Pane = "convert" | "llm" | "ocr" | "general";

export interface SettingsView {
  readonly settings: Settings;
  readonly pane: Pane;
  /** CLI 탐지 결과. 아직 안 돌렸으면 null */
  readonly cli: readonly CliStatus[] | null;
  readonly ollama: { ok: boolean; models: string[]; detail: string } | null;
  /** hybrid 서버 연결 테스트 결과. 아직 안 눌렀으면 null */
  readonly hybrid: { ok: boolean; detail: string; ms: number } | null;
  /** 프롬프트 전문을 펼쳤는가 */
  readonly promptOpen: boolean;
  readonly prompt: string;
  readonly version: string;
}

const sel = (value: string, want: string): string => (value === want ? " selected" : "");

const field = (id: string, label: string, control: string, desc = ""): string => `
  <div class="opt">
    <label for="${id}">${esc(label)}</label>
    ${control}
    ${desc === "" ? "" : `<span class="desc">${desc}</span>`}
  </div>`;

const select = (id: string, value: string, options: ReadonlyArray<[string, string]>, extra = ""): string =>
  `<select id="${id}" data-set="${id}" ${extra}>${options
    .map(([v, label]) => `<option value="${v}"${sel(value, v)}>${esc(label)}</option>`)
    .join("")}</select>`;

const number = (id: string, value: number, min: number, max: number): string =>
  `<input id="${id}" data-set="${id}" type="number" min="${min}" max="${max}" value="${value}">`;

/* ── 변환 ───────────────────────────────────────────────── */

function convertPane(s: Settings): string {
  return `
    <fieldset>
      <legend>새 문서의 기본값</legend>
      <p class="settings-hint">
        여기서 바꾼 값은 <b>앞으로 큐에 들어오는 문서</b>에만 적용됩니다.
        이미 들어와 있는 문서는 인스펙터에서 문서마다 바꿉니다.
      </p>
      ${field(
        "defaultEngine",
        "처리 방식",
        select("defaultEngine", s.defaultEngine, [
          ["local", "로컬 엔진"],
          ["llm", "LLM 엔진"],
        ]),
        s.defaultEngine === "llm"
          ? "LLM 결과는 재현되지 않습니다. 같은 문서를 다시 변환하면 달라질 수 있습니다."
          : "로컬 엔진은 같은 문서에서 항상 같은 결과를 냅니다.",
      )}
      ${field(
        "imageOutput",
        "이미지 처리",
        select("imageOutput", s.imageOutput, [
          ["external", "파일로 참조"],
          ["embedded", "본문에 포함"],
          ["off", "제외"],
        ]),
      )}
    </fieldset>

    <fieldset>
      <legend>큐</legend>
      ${field(
        "concurrency",
        "동시 실행 수",
        number("concurrency", s.concurrency, 1, 4),
        "1~4. 기본 1입니다 — JVM 콜드 스타트 때문에 병렬 이득이 작고, 자바 프로세스 여럿이 동시에 메모리를 먹는 쪽이 더 위험합니다.",
      )}
      ${field(
        "maxFileSizeMb",
        "파일 크기 상한 (MB)",
        number("maxFileSizeMb", s.maxFileSizeMb, 1, 10000),
        "이보다 큰 파일은 큐에 넣지 않고 건너뜁니다.",
      )}
    </fieldset>

    <fieldset>
      <legend>내보내기</legend>
      <label class="check">
        <input type="checkbox" id="frontmatter" data-set="frontmatter" ${s.frontmatter ? "checked" : ""}>
        <span class="txt"><b>YAML 프런트매터</b><span>제목, 출처, 페이지 수 등 메타데이터를 파일 앞에 붙입니다</span></span>
      </label>
      ${field(
        "outputDirRow",
        "기본 저장 위치",
        `<div class="od-row">
          <input class="od-fill" id="outputDirRow" type="text" readonly
                 value="${esc(s.outputDir ?? "")}" placeholder="내보낼 때 물어봅니다">
          <button type="button" class="btn od-fixed" id="pickOutputDir">찾아보기</button>
        </div>`,
      )}
    </fieldset>`;
}

/* ── LLM ────────────────────────────────────────────────── */

/**
 * 세 가지를 구분한다 — 돌았다 / 찾았지만 못 돌았다 / 못 찾았다.
 *
 * 가운데가 이번 결함(`gemini.cmd` 를 찾아 놓고 spawn EINVAL)이 앉는 자리다.
 * 찾은 것과 도는 것을 한 칸으로 합치면 그 상태가 화면에서 사라진다.
 */
function cliRow(status: CliStatus): string {
  const ok = status.found && status.runnable;
  const cls = ok ? "ok" : status.found ? "warn" : "miss";
  return `
    <div class="cli-row ${cls}">
      <span class="cli-head">
        ${icon(ok ? "i-check" : "i-alert", "icon icon-sm")}
        <b>${esc(status.label)}</b>
        <span class="cli-path od-truncate">${esc(status.command ?? "찾지 못함")}</span>
      </span>
      ${ok ? `<span class="cli-detail">실행 확인: ${esc(status.detail)}</span>` : ""}
      ${
        status.found && !status.runnable
          ? `<span class="cli-detail">찾았지만 실행하지 못했습니다 — ${esc(status.detail)}</span>`
          : ""
      }
      ${
        status.found
          ? ""
          : `<pre class="cli-report"><code>${esc(status.report.join("\n"))}</code></pre>`
      }
    </div>`;
}

function llmPane(view: SettingsView): string {
  const s = view.settings;
  const ollama = s.provider === "ollama";

  const modelControl = ollama && view.ollama?.ok && view.ollama.models.length > 0
    ? select("model", s.model, [["", "(모델을 고르세요)"], ...view.ollama.models.map((m) => [m, m] as [string, string])])
    : `<input id="model" data-set="model" type="text" value="${esc(s.model)}"
             placeholder="${ollama ? "예: qwen2.5:7b (필수)" : "비우면 CLI 기본값"}">`;

  return `
    <fieldset>
      <legend>프로바이더</legend>
      ${field(
        "provider",
        "CLI",
        select("provider", s.provider, [
          ["claude", "Claude Code"],
          ["gemini", "Gemini CLI"],
          ["codex", "Codex CLI"],
          ["ollama", "Ollama (로컬 모델)"],
        ]),
      )}
      ${field(
        "model",
        "모델",
        modelControl,
        ollama
          ? view.ollama === null
            ? "설치된 모델을 조회하는 중…"
            : view.ollama.ok
              ? `설치된 모델 ${view.ollama.models.length}개를 불러왔습니다.`
              : `${esc(view.ollama.detail)} — 이름을 직접 적으면 CLI 단독으로 동작합니다.`
          : "CLI 가 받는 모델 이름을 그대로 적습니다. 비우면 CLI 기본값을 씁니다.",
      )}
      ${
        ollama
          ? `<p class="settings-hint">
               본문 생성은 <b>CLI 가 합니다.</b> 모델 목록과 컨텍스트 길이 조회만
               <code>${esc(s.ollamaUrl)}</code> 루프백 HTTP 를 씁니다.
               <b>외부로 나가는 통신은 없습니다.</b>
             </p>
             ${field("ollamaUrl", "루프백 주소", `<input id="ollamaUrl" data-set="ollamaUrl" type="text" value="${esc(s.ollamaUrl)}">`)}`
          : ""
      }
      ${field(
        "inputMode",
        "입력 모드",
        select(
          "inputMode",
          s.inputMode,
          [
            ["B", "B — 로컬 파싱 후 재가공"],
            ["A", "A — CLI 가 파일을 직접 읽음"],
          ],
          ollama ? "data-no-mode-a" : "",
        ),
        ollama
          ? "Ollama 는 파일 읽기 도구가 없어 모드 A 를 쓸 수 없습니다."
          : s.inputMode === "A"
            ? "변환할 파일 1개만 임시 폴더에 복사해 전달하며, 읽기 도구만 허용합니다. <b>원본 파일의 실제 경로는 전달되지 않습니다.</b>"
            : "로컬 파서가 뽑은 Markdown 을 넘겨 구조를 다듬게 합니다. 모든 프로바이더·모든 형식에서 동작합니다.",
      )}
      ${field(
        "language",
        "출력 언어",
        select("language", s.language, [
          ["keep", "원문 유지"],
          ["ko", "한국어"],
          ["en", "English"],
        ]),
      )}
      ${field(
        "llmTimeoutMin",
        "제한 시간 (분)",
        number("llmTimeoutMin", s.llmTimeoutMin, 1, 180),
        "로컬 모델은 긴 문서에서 수십 분이 걸릴 수 있습니다. 로컬 엔진은 10분 고정입니다.",
      )}
    </fieldset>

    <fieldset>
      <legend>CLI 탐지</legend>
      ${
        view.cli === null
          ? `<p class="settings-hint">탐지하는 중…</p>`
          : view.cli.map(cliRow).join("")
      }
      <div class="od-row settings-actions">
        <button type="button" class="btn" id="redetect">${icon("i-refresh", "icon icon-sm")}<span>다시 탐지</span></button>
        <button type="button" class="btn" id="copyReport">${icon("i-copy", "icon icon-sm")}<span>진단 리포트 복사</span></button>
      </div>
    </fieldset>

    <fieldset>
      <legend>프롬프트</legend>
      <p class="settings-hint">
        LLM 에 보내는 지시문입니다. 사내 검수 대상이 될 수 있어 전문을 열람·복사할 수 있게 둡니다.
        위의 입력 모드·출력 언어를 바꾸면 내용도 바뀝니다.
      </p>
      <div class="od-row settings-actions">
        <button type="button" class="btn" id="togglePrompt">
          ${icon("i-code", "icon icon-sm")}<span>${view.promptOpen ? "접기" : "전문 보기"}</span>
        </button>
        <button type="button" class="btn" id="copyPrompt">${icon("i-copy", "icon icon-sm")}<span>복사</span></button>
      </div>
      ${view.promptOpen ? `<pre class="prompt-text"><code>${esc(view.prompt)}</code></pre>` : ""}
    </fieldset>`;
}

/* ── 일반 ───────────────────────────────────────────────── */

function watchRow(folder: WatchFolder): string {
  return `
    <div class="od-row watch-line">
      ${icon("i-folder", "icon icon-sm")}
      <span class="od-fill od-truncate" title="${esc(folder.path)}">${esc(folder.path)}</span>
      <button type="button" class="btn od-fixed" data-unwatch="${esc(folder.path)}">해제</button>
    </div>`;
}

/* ── OCR (hybrid 서버) ─────────────────────────────────── */

/** 루프백이 아닌 주소인가. main 의 isRemote 와 같은 판정이다. */
function looksRemote(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return !(host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]");
  } catch {
    return false;
  }
}

const cmd = (id: string, text: string): string => `
  <div class="ocr-cmd">
    <code id="${id}">${esc(text)}</code>
    <button type="button" class="btn od-fixed" data-copy="${id}">${icon("i-copy", "icon icon-sm")}<span>복사</span></button>
  </div>`;

function ocrPane(view: SettingsView): string {
  const s = view.settings;
  const remote = s.hybridUrl !== "" && looksRemote(s.hybridUrl);

  return `
    <fieldset>
      <legend>OCR 서버</legend>
      <p class="settings-hint">
        PDF 엔진의 로컬 파이프라인에는 <b>OCR 이 없습니다.</b> 텍스트 레이어가 없는 스캔
        문서는 별도 서버에 넘겨야 인식됩니다. 이 서버는 앱에 포함되어 있지 않아 따로
        설치·구동하셔야 합니다.
      </p>
      ${cmd("ocrInstall", 'pip install "opendataloader-pdf[hybrid]"')}
      ${cmd("ocrStart", 'opendataloader-pdf-hybrid --port 5002 --force-ocr --ocr-lang "ko,en"')}

      ${field(
        "hybridUrl",
        "서버 주소",
        `<input id="hybridUrl" data-set="hybridUrl" type="text" value="${esc(s.hybridUrl)}"
                placeholder="예: http://127.0.0.1:5002 (비우면 OCR 을 쓰지 않습니다)">`,
        "비워 두면 인스펙터의 OCR 토글이 잠깁니다.",
      )}

      ${
        remote
          ? `<p class="settings-warn">
               ${icon("i-alert", "icon icon-sm")}
               루프백이 아닌 주소입니다. OCR 을 켜면 <b>PDF 원본이 ${esc(s.hybridUrl)} 로 전송됩니다.</b>
               사내 규정에 맞는 서버인지 확인하세요.
             </p>`
          : ""
      }

      <div class="od-row settings-actions">
        <button type="button" class="btn" id="testHybrid">
          ${icon("i-refresh", "icon icon-sm")}<span>연결 테스트</span>
        </button>
      </div>

      ${
        view.hybrid === null
          ? ""
          : view.hybrid.ok
            ? `<div class="cli-row ok">
                 <span class="cli-head">
                   ${icon("i-check", "icon icon-sm")}
                   <b>연결됨</b>
                   <span class="cli-path">${esc(view.hybrid.detail)} · ${view.hybrid.ms}ms</span>
                 </span>
                 <span class="cli-detail">인스펙터에서 문서마다 OCR 을 켤 수 있습니다.</span>
               </div>`
            : `<div class="cli-row miss">
                 <span class="cli-head">
                   ${icon("i-alert", "icon icon-sm")}
                   <b>연결되지 않음</b>
                 </span>
                 <span class="cli-detail">${esc(view.hybrid.detail)}</span>
                 <pre class="cli-report"><code>확인할 것:
  1) 위 2번 명령으로 서버를 띄웠는지
  2) 포트 번호가 주소와 같은지
  3) 방화벽이 그 포트를 막고 있지 않은지</code></pre>
               </div>`
      }
    </fieldset>`;
}

function generalPane(view: SettingsView): string {
  const s = view.settings;
  return `
    <fieldset>
      <legend>감시 폴더</legend>
      ${
        s.watch.length === 0
          ? `<p class="settings-hint">감시 중인 폴더가 없습니다. 폴더를 걸면 새 문서가 들어올 때 자동으로 변환합니다.</p>`
          : s.watch.map(watchRow).join("")
      }
      <div class="od-row settings-actions">
        <button type="button" class="btn" id="addWatchFromSettings">
          ${icon("i-plus", "icon icon-sm")}<span>감시 폴더 추가</span>
        </button>
      </div>
    </fieldset>

    <fieldset>
      <legend>모양</legend>
      ${field(
        "theme",
        "테마",
        select("theme", s.theme, [
          ["system", "시스템 설정 따름"],
          ["light", "라이트"],
          ["dark", "다크"],
        ]),
      )}
    </fieldset>

    <fieldset>
      <legend>정보</legend>
      <dl class="meta">
        <div><dt>Electron</dt><dd>${esc(view.version)}</dd></div>
        <div><dt>PDF</dt><dd>opendataloader-pdf (Apache-2.0)</dd></div>
        <div><dt>DOCX · XLSX · XLS</dt><dd>kordoc (MIT)</dd></div>
        <div><dt>PPTX</dt><dd>자체 구현 · markitdown (MIT) 규칙 참고</dd></div>
      </dl>
      <p class="settings-hint">
        동봉한 구성요소의 라이선스 전문은 설치 폴더의 <code>resources/</code> 에 있습니다.
      </p>
    </fieldset>`;
}

export function renderSettings(host: HTMLElement, view: SettingsView): void {
  host.innerHTML =
    view.pane === "convert"
      ? convertPane(view.settings)
      : view.pane === "llm"
        ? llmPane(view)
        : view.pane === "ocr"
          ? ocrPane(view)
          : generalPane(view);
}
