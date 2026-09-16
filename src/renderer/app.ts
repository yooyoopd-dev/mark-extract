/**
 * 렌더러 진입점. design/index.html 의 렌더 파이프라인과 이벤트 바인딩을 옮겼다.
 *
 * 시제품의 가짜 데이터와 변환 시뮬레이션 자리에 실제 IPC 가 들어간다. 문서 목록은
 * 아직 렌더러가 들고 있고, 5단계에서 main 의 변환 큐로 옮긴다.
 */
import { renderSidebar } from "./views/sidebar.js";
import { renderList } from "./views/list.js";
import { logText, renderViewer } from "./views/viewer.js";
import { renderInspector } from "./views/inspector.js";
import { initToasts, toast } from "./views/toast.js";
import { openPalette, type Command } from "./views/palette.js";
import { addDoc, docs, getDoc, kindOf, state, visibleDocs, type Doc, type Tab } from "./state.js";

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T =>
  document.querySelector<T>(selector)!;
const $$ = <T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T[] =>
  Array.from(root.querySelectorAll<T>(selector));

const app = $("#app");
const nav = $("#nav");
const docList = $("#docList");
const listTitle = $("#listTitle");
const panel = $("#panel");
const crumbs = $("#crumbs");
const warnCount = $("#warnCount");
const inspBody = $("#inspBody");

/* ── 테마 ───────────────────────────────────────────────── */

const prefersDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

function applyTheme(): void {
  const root = document.documentElement;
  if (state.theme === "system") delete root.dataset["theme"];
  else root.dataset["theme"] = state.theme;

  const dark = state.theme === "dark" || (state.theme === "system" && prefersDark());
  $("#themeLabel").textContent = dark ? "라이트 모드" : "다크 모드";
  $("#themeIcon").innerHTML = `<use href="#${dark ? "i-sun" : "i-moon"}"/>`;
  $("#themeToggle").setAttribute("aria-pressed", String(dark));
}

/* ── 렌더 ───────────────────────────────────────────────── */

function renderStatusbar(): void {
  const running = docs.filter((d) => d.status === "run").length;
  const queued = docs.filter((d) => d.status === "queued").length;
  const done = docs.filter((d) => d.status === "done" && d.result);

  $("#sbQueue").textContent =
    running > 0 ? `${running}건 변환 중` : queued > 0 ? `${queued}건 대기` : "큐 대기 없음";
  $("#sbDot").className = `dot${running > 0 ? " run" : ""}`;

  const average =
    done.length > 0 ? done.reduce((sum, d) => sum + (d.result?.meta.elapsedMs ?? 0), 0) / done.length : 0;
  $("#sbSpeed").textContent = average > 0 ? `평균 ${(average / 1000).toFixed(1)}초/문서` : "—";

  const selected = getDoc(state.selected);
  $("#sbEngine").textContent = selected?.result?.meta.engine ?? "—";
  $("#sbTokens").textContent = selected?.result ? `${selected.result.markdown.length.toLocaleString("ko-KR")}자` : "";
}

function render(): void {
  app.dataset["pane"] = state.pane;

  renderSidebar(nav);
  renderList(docList, listTitle);
  renderViewer(panel, crumbs, warnCount, getDoc(state.selected));
  renderInspector(inspBody, getDoc(state.selected));
  renderStatusbar();

  for (const tab of $$<HTMLButtonElement>(".tab")) {
    const selected = tab.dataset["tab"] === state.tab;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const chip of $$<HTMLButtonElement>(".chip")) {
    chip.setAttribute("aria-pressed", String(chip.dataset["status"] === state.status));
  }

  const star = $("#starBtn");
  star.setAttribute("aria-pressed", String(getDoc(state.selected)?.star ?? false));
}

/* ── 변환 ───────────────────────────────────────────────── */

async function convert(doc: Doc): Promise<void> {
  doc.status = "run";
  render();

  try {
    const result = await window.markExtract.convert(doc.path);
    doc.result = result;
    doc.status = result.ok ? "done" : "failed";
    if (result.ok && result.warnings.length > 0) {
      toast(`${doc.name} — 경고 ${result.warnings.length}건`, "err");
    }
  } catch (error) {
    doc.status = "failed";
    doc.result = {
      ok: false,
      markdown: "",
      warnings: [],
      log: [],
      meta: { engine: "-", elapsedMs: 0 },
      error: {
        code: "IPC_FAILED",
        message: error instanceof Error ? error.message : String(error),
        actions: ["retry-plain"],
      },
    };
  }
  render();
}

function addFiles(files: readonly { path: string; name: string; size: number }[]): void {
  let added = 0;
  let skipped = 0;

  for (const file of files) {
    const kind = kindOf(file.name);
    if (!kind) {
      skipped += 1;
      continue;
    }
    const doc = addDoc(file.path, file.name, file.size, kind);
    added += 1;
    if (state.selected === null) {
      state.selected = doc.id;
      state.pane = "viewer";
    }
    void convert(doc);
  }

  if (skipped > 0) toast(`${skipped}건은 지원하지 않는 형식이라 건너뛰었습니다.`, "err");
  if (added > 0) render();
}

/* ── 이벤트 ─────────────────────────────────────────────── */

function selectDoc(doc: Doc): void {
  state.selected = doc.id;
  state.pane = "viewer";
  render();
}

function bind(): void {
  nav.addEventListener("click", (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>(".nav-item");
    if (!item?.dataset["view"]) return;
    state.view = item.dataset["view"];
    render();
  });

  docList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("#emptyAction")) {
      if (state.query || state.status !== "all") {
        state.query = "";
        state.status = "all";
        $<HTMLInputElement>("#listSearch").value = "";
        render();
      } else {
        void pickFiles();
      }
      return;
    }
    const card = target.closest<HTMLElement>(".doc");
    const doc = getDoc(card?.dataset["id"] ?? null);
    if (doc) selectDoc(doc);
  });

  // 목록 키보드 이동
  docList.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();

    const list = visibleDocs();
    const at = list.findIndex((d) => d.id === state.selected);
    const next = list[Math.min(Math.max(at + (event.key === "ArrowDown" ? 1 : -1), 0), list.length - 1)];
    if (next) {
      state.selected = next.id;
      render();
      $(`.doc[data-id="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
    }
  });

  const search = $<HTMLInputElement>("#listSearch");
  search.addEventListener("input", () => {
    state.query = search.value;
    $("#clearSearch").hidden = search.value === "";
    render();
  });
  $("#clearSearch").addEventListener("click", () => {
    search.value = "";
    state.query = "";
    $("#clearSearch").hidden = true;
    render();
  });

  for (const chip of $$<HTMLButtonElement>(".chip")) {
    chip.addEventListener("click", () => {
      state.status = (chip.dataset["status"] ?? "all") as typeof state.status;
      render();
    });
  }

  $("#sortBtn").addEventListener("click", () => {
    state.sort = state.sort === "modified" ? "name" : state.sort === "name" ? "size" : "modified";
    toast(`정렬: ${{ modified: "추가순", name: "이름순", size: "크기순" }[state.sort]}`);
    render();
  });

  $("#addFile").addEventListener("click", () => void pickFiles());

  // 탭
  for (const tab of $$<HTMLButtonElement>(".tab")) {
    tab.addEventListener("click", () => {
      state.tab = (tab.dataset["tab"] ?? "render") as Tab;
      render();
    });
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      const tabs = $$<HTMLButtonElement>(".tab");
      const at = tabs.indexOf(tab);
      const next = tabs[(at + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      next?.click();
      next?.focus();
    });
  }

  // 뷰어 액션
  $("#backToList").addEventListener("click", () => {
    state.pane = "list";
    render();
  });
  $("#starBtn").addEventListener("click", () => {
    const doc = getDoc(state.selected);
    if (!doc) return;
    doc.star = !doc.star;
    render();
  });
  $("#reconvertBtn").addEventListener("click", () => {
    const doc = getDoc(state.selected);
    if (doc) void convert(doc);
  });
  $("#copyBtn").addEventListener("click", () => void copyMarkdown());
  $("#deleteBtn").addEventListener("click", () => {
    const at = docs.findIndex((d) => d.id === state.selected);
    if (at < 0) return;
    const [removed] = docs.splice(at, 1);
    state.selected = docs[Math.min(at, docs.length - 1)]?.id ?? null;
    toast(`${removed?.name ?? "문서"} 을(를) 목록에서 제거했습니다.`);
    render();
  });
  $("#exportBtn").addEventListener("click", () => toast("내보내기는 5단계에서 들어옵니다.", "err"));
  $("#moreBtn").addEventListener("click", () => toast("추가 동작은 아직 없습니다.", "err"));

  // 패널 안에서 위임 — 재변환·복사 버튼은 렌더마다 새로 생긴다
  panel.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const doc = getDoc(state.selected);
    if (!doc) return;

    if (target.closest("#runNow") || target.closest("[data-retry]")) void convert(doc);
    else if (target.closest("#copyLog")) {
      void navigator.clipboard.writeText(logText(doc)).then(() => toast("변환 로그를 복사했습니다."));
    }
  });

  inspBody.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const doc = getDoc(state.selected);
    if (!doc) return;

    if (target.closest("#inspReconvert")) void convert(doc);
    else if (target.closest("#inspCopy")) void copyMarkdown();
    else if (target.closest("#inspExport")) toast("내보내기는 5단계에서 들어옵니다.", "err");

    const sw = target.closest<HTMLElement>(".sw");
    if (sw && !sw.hasAttribute("disabled")) {
      sw.setAttribute("aria-checked", String(sw.getAttribute("aria-checked") !== "true"));
    }
  });

  // 드로어 (좁은 창)
  $("#navToggle").addEventListener("click", () => {
    const open = app.dataset["sidebar"] === "open";
    app.dataset["sidebar"] = open ? "closed" : "open";
    $("#navToggle").setAttribute("aria-expanded", String(!open));
  });
  $("#inspectorOpen").addEventListener("click", () => (app.dataset["inspector"] = "open"));
  $("#inspClose").addEventListener("click", () => (app.dataset["inspector"] = "closed"));
  $("#scrim").addEventListener("click", () => {
    app.dataset["sidebar"] = "closed";
    app.dataset["inspector"] = "closed";
  });

  $("#themeToggle").addEventListener("click", () => {
    const dark = state.theme === "dark" || (state.theme === "system" && prefersDark());
    state.theme = dark ? "light" : "dark";
    applyTheme();
  });

  $("#paletteOpen").addEventListener("click", showPalette);

  // 창 조작 — 프레임 없는 창이라 우리가 그린다
  for (const [id, channel] of [
    ["capMin", "minimize"],
    ["capMax", "maximize"],
    ["capClose", "close"],
  ] as const) {
    $(`#${id}`).addEventListener("click", () => void window.markExtract.window(channel));
  }
}

async function copyMarkdown(): Promise<void> {
  const doc = getDoc(state.selected);
  if (!doc?.result?.ok) return;
  await navigator.clipboard.writeText(doc.result.markdown);
  toast("Markdown 을 복사했습니다.");
}

async function pickFiles(): Promise<void> {
  const files = await window.markExtract.pickFiles();
  addFiles(files);
}

function showPalette(): void {
  const commands: Command[] = [
    { id: "add", label: "파일 추가", icon: "i-plus", hint: "Ctrl+O", run: () => void pickFiles() },
    {
      id: "theme",
      label: "테마 전환",
      icon: "i-moon",
      run: () => {
        const dark = state.theme === "dark" || (state.theme === "system" && prefersDark());
        state.theme = dark ? "light" : "dark";
        applyTheme();
      },
    },
    { id: "copy", label: "Markdown 복사", icon: "i-copy", run: () => void copyMarkdown() },
    {
      id: "reconvert",
      label: "재변환",
      icon: "i-refresh",
      run: () => {
        const doc = getDoc(state.selected);
        if (doc) void convert(doc);
      },
    },
  ];

  openPalette($("#paletteOverlay"), $<HTMLInputElement>("#paletteInput"), $("#paletteList"), commands, selectDoc);
}

/* ── 전역 키보드 · 드래그 앤 드롭 ───────────────────────── */

function globalKeys(): void {
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      showPalette();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
      event.preventDefault();
      void pickFiles();
    } else if (event.key === "Escape") {
      app.dataset["sidebar"] = "closed";
      app.dataset["inspector"] = "closed";
    }
  });
}

function dragAndDrop(): void {
  const overlay = $("#dropOverlay");
  let depth = 0;

  document.addEventListener("dragenter", (event) => {
    event.preventDefault();
    depth += 1;
    overlay.hidden = false;
  });
  document.addEventListener("dragover", (event) => event.preventDefault());
  document.addEventListener("dragleave", () => {
    depth -= 1;
    if (depth <= 0) overlay.hidden = true;
  });
  document.addEventListener("drop", (event) => {
    event.preventDefault();
    depth = 0;
    overlay.hidden = true;

    const files = Array.from(event.dataTransfer?.files ?? []).map((file) => ({
      // sandbox 렌더러에는 File.path 가 없다. preload 의 webUtils 를 거친다.
      path: window.markExtract.getFilePath(file),
      name: file.name,
      size: file.size,
    }));
    addFiles(files);
  });
}

/* ── 시작 ───────────────────────────────────────────────── */

initToasts($("#toasts"));
applyTheme();
bind();
globalKeys();
dragAndDrop();
$("#sbVersion").textContent = `Electron ${window.markExtract.version}`;
render();

// 명령줄로 받은 문서가 있으면 바로 변환한다.
void window.markExtract.initialFiles().then(addFiles);
