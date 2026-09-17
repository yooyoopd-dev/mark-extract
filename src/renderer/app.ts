/**
 * 렌더러 진입점. design/index.html 의 렌더 파이프라인과 이벤트 바인딩을 옮겼다.
 *
 * 5단계부터 문서는 main 의 큐가 들고 있다. 여기서는 스냅샷을 받아 그리고, 사용자
 * 동작은 IPC 로 부탁한 뒤 돌아온 스냅샷을 다시 그린다. 렌더러가 문서를 직접
 * 고치는 곳은 없다 — 그래야 감시 폴더로 들어온 문서와 화면이 어긋나지 않는다.
 */
import { renderSidebar } from "./views/sidebar.js";
import { renderList } from "./views/list.js";
import { logText, renderViewer } from "./views/viewer.js";
import { renderInspector } from "./views/inspector.js";
import { initToasts, toast } from "./views/toast.js";
import { openPalette, type Command } from "./views/palette.js";
import {
  bodyKey,
  docs,
  effectiveOptions,
  getDoc,
  isDirty,
  markdown,
  setDocs,
  state,
  visibleDocs,
  type Doc,
  type DocOptions,
  type DocView,
  type Tab,
} from "./state.js";

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T =>
  document.querySelector<T>(selector)!;
const $$ = <T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T[] =>
  Array.from(root.querySelectorAll<T>(selector));

const app = $("#app");
const nav = $("#nav");
const docList = $("#docList");
const listTitle = $("#listTitle");
const panel = $("#panel");
const dirtyBar = $("#dirtyBar");
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

function toggleTheme(): void {
  const dark = state.theme === "dark" || (state.theme === "system" && prefersDark());
  state.theme = dark ? "light" : "dark";
  applyTheme();
  void window.markExtract.setSettings({ theme: state.theme });
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
  const body = markdown();
  $("#sbTokens").textContent = body === "" ? "" : `${body.length.toLocaleString("ko-KR")}자`;

  $("#sbWatchText").textContent =
    state.watch.length === 0 ? "감시 폴더 없음" : `감시 폴더 ${state.watch.length}곳`;
}

function render(): void {
  app.dataset["pane"] = state.pane;

  const selected = getDoc(state.selected);
  renderSidebar(nav);
  renderList(docList, listTitle);
  renderViewer(panel, crumbs, warnCount, dirtyBar, selected);
  renderInspector(inspBody, selected);
  renderStatusbar();

  for (const tab of $$<HTMLButtonElement>(".tab")) {
    const isSelected = tab.dataset["tab"] === state.tab;
    tab.setAttribute("aria-selected", String(isSelected));
    tab.tabIndex = isSelected ? 0 : -1;
  }
  for (const chip of $$<HTMLButtonElement>(".chip")) {
    chip.setAttribute("aria-pressed", String(chip.dataset["status"] === state.status));
  }

  $("#starBtn").setAttribute("aria-pressed", String(selected?.star ?? false));
  const usable = selected?.status === "done";
  $<HTMLButtonElement>("#copyBtn").disabled = !usable;
  $<HTMLButtonElement>("#exportBtn").disabled = !usable;
}

/* ── main 의 큐와 맞추기 ────────────────────────────────── */

/** 본문을 받아 오는 중인 열쇠. 늦게 돌아온 응답이 새 선택을 덮지 않게 막는다. */
let wanted: string | null = null;

async function syncBody(): Promise<void> {
  const doc = getDoc(state.selected);
  if (!doc || doc.status !== "done") {
    wanted = null;
    state.body = null;
    return;
  }

  const key = bodyKey(doc);
  if (state.body?.key === key || wanted === key) return;

  wanted = key;
  const text = await window.markExtract.markdown(doc.id);
  if (wanted !== key) return; // 그 사이 다른 문서를 골랐다
  state.body = { key, markdown: text };
  render();
}

/**
 * 변환 중인 문서가 있으면 1초마다 다시 그린다. 경과 시간이 흐르는 것만으로도
 * 멈춘 것이 아니라는 신호가 된다 — main 이 진행 이벤트를 보내지 않는 동안에도.
 */
let ticking: number | null = null;

function syncTicker(): void {
  const running = docs.some((d) => d.status === "run");
  if (running && ticking === null) {
    ticking = window.setInterval(render, 1000);
  } else if (!running && ticking !== null) {
    window.clearInterval(ticking);
    ticking = null;
  }
}

function apply(views: DocView[]): void {
  setDocs(views);

  // 지워진 문서를 가리키고 있으면 놓는다.
  if (state.selected !== null && !getDoc(state.selected)) {
    state.selected = null;
    state.body = null;
  }
  // 첫 문서가 들어오면 바로 보여 준다.
  if (state.selected === null && docs.length > 0) state.selected = docs[0]!.id;

  render();
  syncTicker();
  void syncBody();
}

const refresh = async (): Promise<void> => apply(await window.markExtract.list());

async function addPaths(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const { added, skipped } = await window.markExtract.add(paths);
  if (skipped > 0) toast(`${skipped}건은 지원하지 않는 형식이라 건너뛰었습니다.`, "err");
  if (added > 0) state.pane = "viewer";
  await refresh();
}

/* ── 이벤트 ─────────────────────────────────────────────── */

function selectDoc(doc: Doc): void {
  state.selected = doc.id;
  state.pane = "viewer";
  render();
  void syncBody();
}

/** 인스펙터에서 만진 옵션으로 재변환한다. 손댄 것이 없으면 저장된 옵션 그대로. */
function reconvert(doc: Doc): void {
  const options = effectiveOptions(doc);
  state.draft = null;
  void window.markExtract.reconvert(doc.id, options).then(refresh);
}

function editOption(doc: Doc, patch: DocOptions): void {
  state.draft = { id: doc.id, options: { ...effectiveOptions(doc), ...patch } };
  if (!isDirty(doc)) state.draft = null;
  render();
}

function bind(): void {
  nav.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const unwatch = target.closest<HTMLElement>("[data-unwatch]")?.dataset["unwatch"];
    if (unwatch) {
      void window.markExtract.removeWatch(unwatch).then((watch) => {
        state.watch = watch;
        toast("감시를 해제했습니다.");
        render();
      });
      return;
    }

    const item = target.closest<HTMLElement>(".nav-item");
    if (!item?.dataset["view"]) return;
    state.view = item.dataset["view"];
    render();
  });

  $("#addWatch").addEventListener("click", () => void pickWatch());
  $("#sbWatch").addEventListener("click", () => void pickWatch());

  docList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("#emptyAction")) {
      if (state.query || state.status !== "all") {
        state.query = "";
        state.status = "all";
        $<HTMLInputElement>("#listSearch").value = "";
        $("#clearSearch").hidden = true;
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
      void syncBody();
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
    if (doc) void window.markExtract.star(doc.id, !doc.star).then(refresh);
  });
  $("#reconvertBtn").addEventListener("click", () => {
    const doc = getDoc(state.selected);
    if (doc) reconvert(doc);
  });
  $("#copyBtn").addEventListener("click", () => void copyMarkdown());
  $("#deleteBtn").addEventListener("click", () => {
    const doc = getDoc(state.selected);
    if (!doc) return;
    // 선택을 목록에서의 다음 문서로 옮겨 둔다. apply() 가 비어 있으면 처음으로 돌린다.
    const list = visibleDocs();
    const at = list.findIndex((d) => d.id === doc.id);
    state.selected = (list[at + 1] ?? list[at - 1])?.id ?? null;

    void window.markExtract.remove(doc.id).then(() => {
      toast(`${doc.name} 을(를) 목록에서 제거했습니다.`);
      return refresh();
    });
  });
  $("#exportBtn").addEventListener("click", () => openExport());
  $("#moreBtn").addEventListener("click", () => {
    const doc = getDoc(state.selected);
    if (doc) void window.markExtract.reveal(doc.path);
  });

  // 패널 안에서 위임 — 버튼은 렌더마다 새로 생긴다
  panel.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const doc = getDoc(state.selected);
    if (!doc) return;

    if (target.closest("[data-retry]")) reconvert(doc);
    else if (target.closest("#cancelRun")) void window.markExtract.cancel(doc.id).then(refresh);
    else if (target.closest("#copyLog")) {
      void navigator.clipboard.writeText(logText(doc)).then(() => toast("변환 로그를 복사했습니다."));
    }
  });

  dirtyBar.addEventListener("click", (event) => {
    const doc = getDoc(state.selected);
    if (doc && (event.target as HTMLElement).closest("#dirtyRun")) reconvert(doc);
  });

  inspBody.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const doc = getDoc(state.selected);
    if (!doc) return;

    if (target.closest("#inspReconvert")) return reconvert(doc);
    if (target.closest("#inspCopy")) return void copyMarkdown();
    if (target.closest("#inspExport")) return openExport();

    const sw = target.closest<HTMLElement>(".sw");
    if (sw && !sw.hasAttribute("disabled") && sw.dataset["opt"] === "strip") {
      // 스위치는 "머리글·바닥글 제거"이고 옵션은 "포함"이라 값이 뒤집힌다.
      editOption(doc, { includeHeaderFooter: sw.getAttribute("aria-checked") === "true" });
    }
  });

  inspBody.addEventListener("change", (event) => {
    const field = (event.target as HTMLElement).closest<HTMLSelectElement | HTMLInputElement>("[data-opt]");
    const doc = getDoc(state.selected);
    if (!field || !doc) return;

    switch (field.dataset["opt"]) {
      case "tableMethod":
        return editOption(doc, { tableMethod: field.value as DocOptions["tableMethod"] });
      case "imageOutput":
        return editOption(doc, { imageOutput: field.value as DocOptions["imageOutput"] });
      case "engine":
        return editOption(doc, { engine: field.value as DocOptions["engine"] });
      case "provider":
        return editOption(doc, { provider: field.value as DocOptions["provider"] });
      case "inputMode":
        return editOption(doc, { inputMode: field.value as DocOptions["inputMode"] });
      case "model":
        // 비우면 undefined 로 되돌린다. "" 로 두면 저장된 undefined 와 달라 보여
        // 바꾼 것이 없는데도 "변경됨" 띠가 뜬다.
        return editOption(doc, { model: field.value.trim() || undefined });
      default:
        return;
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

  $("#themeToggle").addEventListener("click", toggleTheme);
  $("#paletteOpen").addEventListener("click", showPalette);

  bindExport();

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
  if (!doc || doc.status !== "done") return;
  await navigator.clipboard.writeText(await window.markExtract.markdown(doc.id));
  toast("Markdown 을 복사했습니다.");
}

async function pickFiles(): Promise<void> {
  const { added, skipped } = await window.markExtract.pickFiles();
  if (skipped > 0) toast(`${skipped}건은 지원하지 않는 형식이라 건너뛰었습니다.`, "err");
  if (added > 0) state.pane = "viewer";
  await refresh();
}

async function pickWatch(): Promise<void> {
  const before = state.watch.length;
  state.watch = await window.markExtract.addWatch();
  if (state.watch.length > before) toast("폴더를 감시합니다. 새 문서가 들어오면 자동으로 변환합니다.");
  await refresh();
}

/* ── 내보내기 ───────────────────────────────────────────── */

const exportOverlay = $("#exportOverlay");
const exportForm = $<HTMLFormElement>("#exportForm");
const exportPath = $<HTMLInputElement>("#exportPath");

function openExport(): void {
  const doc = getDoc(state.selected);
  if (doc?.status !== "done") {
    toast("변환이 끝난 문서만 내보낼 수 있습니다.", "err");
    return;
  }

  $("#exportSub").textContent = doc.name;
  exportPath.value = state.outputDir ?? "";
  $<HTMLInputElement>("#optFm").checked = state.frontmatter;
  exportOverlay.hidden = false;
}

const closeExport = (): void => {
  exportOverlay.hidden = true;
};

function bindExport(): void {
  $("#exportBrowse").addEventListener("click", () => {
    void window.markExtract.pickOutputDir().then((dir) => {
      if (dir) exportPath.value = dir;
    });
  });

  exportOverlay.addEventListener("click", (event) => {
    if (event.target === exportOverlay || (event.target as HTMLElement).closest("[data-close]")) closeExport();
  });

  exportForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void runExport();
  });
}

async function runExport(): Promise<void> {
  const doc = getDoc(state.selected);
  if (!doc) return;

  const frontmatter = $<HTMLInputElement>("#optFm").checked;
  const clipboard = $<HTMLInputElement>('input[name="fmt"]:checked').value === "clip";
  state.frontmatter = frontmatter;

  if (clipboard) {
    closeExport();
    await copyMarkdown();
    return;
  }

  const outputDir = exportPath.value.trim();
  if (outputDir === "") {
    toast("저장할 폴더를 먼저 선택하세요.", "err");
    return;
  }

  closeExport();
  const result = await window.markExtract.exportMarkdown({ ids: [doc.id], outputDir, frontmatter });
  state.outputDir = result.outputDir;

  if (result.written === 0) toast("내보내지 못했습니다. 폴더 권한을 확인하세요.", "err");
  else toast(`${result.written}개 파일을 저장했습니다.`);
}

/* ── 커맨드 팔레트 ──────────────────────────────────────── */

function showPalette(): void {
  const commands: Command[] = [
    { id: "add", label: "파일 추가", icon: "i-plus", hint: "Ctrl+O", run: () => void pickFiles() },
    { id: "watch", label: "감시 폴더 추가", icon: "i-folder", run: () => void pickWatch() },
    { id: "theme", label: "테마 전환", icon: "i-moon", run: toggleTheme },
    { id: "copy", label: "Markdown 복사", icon: "i-copy", run: () => void copyMarkdown() },
    { id: "export", label: "Markdown 내보내기", icon: "i-down", hint: "Ctrl+E", run: openExport },
    {
      id: "reconvert",
      label: "재변환",
      icon: "i-refresh",
      run: () => {
        const doc = getDoc(state.selected);
        if (doc) reconvert(doc);
      },
    },
  ];

  openPalette($("#paletteOverlay"), $<HTMLInputElement>("#paletteInput"), $("#paletteList"), commands, selectDoc);
}

/* ── 전역 키보드 · 드래그 앤 드롭 ───────────────────────── */

function globalKeys(): void {
  document.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "k") {
      event.preventDefault();
      showPalette();
    } else if (mod && event.key.toLowerCase() === "o") {
      event.preventDefault();
      void pickFiles();
    } else if (mod && event.key.toLowerCase() === "e") {
      event.preventDefault();
      openExport();
    } else if (event.key === "Escape") {
      if (!exportOverlay.hidden) closeExport();
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

    // sandbox 렌더러에는 File.path 가 없다. preload 의 webUtils 를 거친다.
    // 폴더를 놓았을 때도 경로는 같은 방법으로 얻고, 안을 훑는 일은 main 이 한다.
    const paths = Array.from(event.dataTransfer?.files ?? [])
      .map((file) => window.markExtract.getFilePath(file))
      .filter((path) => path !== "");
    void addPaths(paths);
  });
}

/* ── 시작 ───────────────────────────────────────────────── */

initToasts($("#toasts"));
bind();
globalKeys();
dragAndDrop();
$("#sbVersion").textContent = `Electron ${window.markExtract.version}`;

// main 이 큐를 바꿀 때마다(변환 진행, 감시 폴더 유입) 스냅샷이 온다.
window.markExtract.onChanged(apply);

void (async () => {
  const settings = await window.markExtract.getSettings();
  state.theme = settings.theme;
  state.watch = settings.watch;
  state.outputDir = settings.outputDir;
  state.frontmatter = settings.frontmatter;
  applyTheme();

  await refresh();

  // 명령줄로 받은 문서. 탐색기에서 "연결 프로그램"으로 열 때 들어온다.
  await addPaths(await window.markExtract.initialFiles());
})();
