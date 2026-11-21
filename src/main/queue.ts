/**
 * 문서 저장소와 변환 큐 (docs/design/01-architecture.md).
 *
 * 5단계부터 문서는 main 이 들고 있다. 렌더러는 이벤트로 받아 그리기만 한다.
 *
 * 동시 실행은 기본 1이다. JVM 콜드 스타트가 문서당 수백 ms~수 초라 병렬화 이득이
 * 작고, 여러 자바 프로세스가 동시에 메모리를 먹는 쪽이 더 위험하다. 설정에서 4까지
 * 올릴 수 있다.
 */
import { EventEmitter } from "node:events";
import { readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { convert } from "./convert";
import { NEW_META, readMd, saveMd as writeMd, type MdMeta, type SaveOutcome } from "./md-file";
import { settings } from "./settings";
import type { DocKind, DocOptions, DocView, ExportRequest, ExportResult } from "../shared/doc";
import type { ParseResult } from "../shared/parse";

const SUPPORTED: readonly DocKind[] = ["pdf", "docx", "xlsx", "xls", "pptx", "html", "eml", "md"];
/** 폴더를 통째로 끌어다 놓았을 때 훑을 깊이. 무한히 들어가지 않는다. */
const MAX_DEPTH = 4;
/** 큐가 무한히 커지지 않도록 (docs/design/05-packaging.md). */
const MAX_DOCS = 1000;

interface Entry {
  view: Mutable<DocView>;
  markdown: string;
  abort: AbortController | null;
  /** md 문서만. 저장할 때 줄바꿈·BOM 을 되돌리고 바깥 수정을 알아챈다 */
  md?: MdMeta;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const entries = new Map<string, Entry>();
const pending: string[] = [];
let running = 0;
let seq = 0;

export const events = new EventEmitter();

const emit = (): void => {
  events.emit("changed");
};

export const list = (): DocView[] => [...entries.values()].map((e) => e.view);
export const markdownOf = (id: string): string => entries.get(id)?.markdown ?? "";

function kindOf(path: string): DocKind | null {
  const raw = extname(path).slice(1).toLowerCase();
  // .htm 은 같은 형식의 옛 확장자다. .markdown 도 마찬가지.
  const ext = (raw === "htm" ? "html" : raw === "markdown" ? "md" : raw) as DocKind;
  return SUPPORTED.includes(ext) ? ext : null;
}

function snippetOf(result: ParseResult, markdown: string): string {
  if (!result.ok) return result.error?.message ?? "변환에 실패했습니다.";
  return markdown
    // PPTX 의 슬라이드 경계 주석은 본문이 아니다.
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/[#>|*`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** 오래된 완료 항목부터 덜어낸다. 진행 중·실패는 건드리지 않는다. */
function trim(): void {
  if (entries.size <= MAX_DOCS) return;

  const removable = [...entries.values()]
    // md 는 덜어내지 않는다 — 렌더러에 저장 안 한 편집이 있을 수 있다 (build.38).
    .filter((e) => e.view.status === "done" && !e.md)
    .sort((a, b) => a.view.addedAt - b.view.addedAt);

  for (const entry of removable) {
    if (entries.size <= MAX_DOCS) break;
    entries.delete(entry.view.id);
  }
}

/**
 * 설정에서 새 문서의 출발 옵션을 만든다.
 *
 * 이미 큐에 있는 문서는 건드리지 않는다 — 설정을 바꿨다고 사용자가 인스펙터에서
 * 손댄 값이 조용히 날아가면 안 된다.
 */
function defaultOptions(): DocOptions {
  const s = settings();
  // 제한 시간은 엔진마다 다르다. 전에는 로컬 문서에도 LLM 값을 심어, 설정 화면이
  // "로컬은 10분 고정" 이라 적어 둔 것과 실제가 어긋나 있었다 (build.28 실측).
  const timeoutMin = s.defaultEngine === "llm" ? s.llmTimeoutMin : s.localTimeoutMin;
  const options: DocOptions = {
    engine: s.defaultEngine,
    imageOutput: s.imageOutput,
    timeoutMs: timeoutMin * 60_000,
  };
  if (s.defaultEngine !== "llm") return options;

  return {
    ...options,
    provider: s.provider,
    inputMode: s.inputMode,
    ...(s.model === "" ? {} : { model: s.model }),
  };
}

/** 파일 하나를 큐에 넣는다. 이미 같은 경로가 있으면 건너뛴다. */
async function addFile(path: string, options?: DocOptions): Promise<DocView | null> {
  const kind = kindOf(path);
  if (!kind) return null;
  if ([...entries.values()].some((e) => e.view.path === path)) return null;

  let size = 0;
  try {
    size = (await stat(path)).size;
  } catch {
    return null;
  }

  // 너무 큰 파일은 넣지 않는다 (결정 21). 넣어 두면 변환이 오래 끌다 실패한다.
  const limit = settings().maxFileSizeMb * 1024 * 1024;
  if (size > limit) {
    oversized.push({ name: basename(path), mb: Math.round(size / 1024 / 1024) });
    return null;
  }

  const view: Mutable<DocView> = {
    id: `d${++seq}`,
    name: basename(path),
    path,
    kind,
    size,
    status: "queued",
    addedAt: Date.now(),
    options: options ?? defaultOptions(),
    result: null,
    snippet: "대기 중입니다.",
  };

  if (kind === "md") return openMd(view);

  entries.set(view.id, { view, markdown: "", abort: null });
  pending.push(view.id);
  trim();
  return view;
}

/** 폴더면 안을 훑고, 파일이면 그대로. 지원하지 않는 형식은 조용히 거른다. */
async function expand(path: string, md: boolean, depth = 0): Promise<string[]> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return [];
  }

  if (info.isFile()) {
    // md 는 하나씩 직접 열 때만 받는다. 폴더를 훑거나 감시 폴더로 들어오면 넣지 않는다 —
    // 이 앱이 내보낸 .md 가 감시 폴더로 되돌아 들어오는 고리가 생긴다.
    if (kindOf(path) === "md" && (!md || depth > 0)) return [];
    if (kindOf(path)) return [path];
    unsupported.push(basename(path));
    return [];
  }
  if (!info.isDirectory() || depth >= MAX_DEPTH) return [];

  const found: string[] = [];
  for (const name of await readdir(path)) {
    if (name.startsWith(".")) continue;
    found.push(...(await expand(join(path, name), md, depth + 1)));
  }
  return found;
}

export interface AddResult {
  readonly added: number;
  readonly skipped: number;
  /** 크기 상한을 넘어 건너뛴 파일. 조용히 사라지면 사용자가 이유를 알 수 없다. */
  readonly oversized: ReadonlyArray<{ name: string; mb: number }>;
  /**
   * 확장자가 지원 목록에 없어 건너뛴 파일 이름.
   *
   * build.25 실측: 사내 DRM 도구가 확장자를 바꿔 놓으면 파일이 목록에 들어오지도
   * 않는다. 숫자만 알려 주면 사용자는 어느 파일인지 알 수 없다.
   */
  readonly unsupported: ReadonlyArray<string>;
}

/** addFile·expand 가 채우고 add 가 비운다. 한 번의 add 호출 안에서만 산다. */
const oversized: Array<{ name: string; mb: number }> = [];
const unsupported: string[] = [];

/** `md: false` 는 감시 폴더가 쓴다. */
export async function add(paths: readonly string[], { md = true } = {}): Promise<AddResult> {
  let added = 0;
  let skipped = 0;
  oversized.length = 0;
  unsupported.length = 0;

  for (const path of paths) {
    const files = await expand(path, md);
    if (files.length === 0) skipped += 1;

    for (const file of files) {
      const doc = await addFile(file);
      if (doc) added += 1;
      else skipped += 1;
    }
  }

  emit();
  pump();
  return { added, skipped, oversized: [...oversized], unsupported: [...unsupported] };
}

export function remove(id: string): void {
  const entry = entries.get(id);
  entry?.abort?.abort();
  entries.delete(id);

  const at = pending.indexOf(id);
  if (at >= 0) pending.splice(at, 1);
  emit();
}

/* ── Markdown 파일 (build.38) ─────────────────────────── */
//
// 변환하지 않으므로 큐를 지나지 않는다. 읽으면 곧바로 "완료" 다.

function mdResult(meta: MdMeta): Omit<ParseResult, "markdown"> {
  return {
    ok: true,
    warnings:
      meta.charset === "euc-kr"
        ? [{ code: "ENCODING_CONVERTED", message: "EUC-KR 로 된 파일입니다. 저장하면 UTF-8 로 바뀝니다." }]
        : [],
    log: [
      { label: "형식", value: "Markdown (변환 없음)" },
      { label: "인코딩", value: meta.charset === "utf-8" ? `UTF-8${meta.bom ? " (BOM)" : ""}` : "EUC-KR" },
      { label: "줄바꿈", value: meta.eol === "\r\n" ? "CRLF" : "LF" },
    ],
    meta: { engine: "Markdown 파일", elapsedMs: 0 },
  };
}

function setMd(entry: Entry, text: string, meta: MdMeta, size: number): void {
  entry.markdown = text;
  entry.md = meta;
  entry.view.size = size;
  entry.view.status = "done";
  entry.view.result = mdResult(meta);
  // 같은 "완료" 상태에서 본문이 바뀐다. 렌더러의 본문 캐시가 이것으로 낡음을 안다.
  entry.view.rev = (entry.view.rev ?? 0) + 1;
  entry.view.snippet = snippetOf({ ok: true, markdown: text, warnings: [], log: [], meta: { engine: "", elapsedMs: 0 } }, text);
}

async function openMd(view: Mutable<DocView>): Promise<DocView | null> {
  let read;
  try {
    read = await readMd(view.path);
  } catch {
    return null;
  }
  const entry: Entry = { view, markdown: "", abort: null };
  setMd(entry, read.text, read.meta, read.size);
  entries.set(view.id, entry);
  trim();
  return view;
}

/** 새 문서. 경로가 없다 — 처음 저장할 때 "다른 이름으로 저장" 을 거친다. */
export function newMd(): DocView {
  const view: Mutable<DocView> = {
    id: `d${++seq}`,
    name: "제목 없음.md",
    path: "",
    kind: "md",
    size: 0,
    status: "done",
    addedAt: Date.now(),
    options: {},
    result: null,
    snippet: "",
  };
  const entry: Entry = { view, markdown: "", abort: null };
  setMd(entry, "", NEW_META, 0);
  entries.set(view.id, entry);
  emit();
  return view;
}

/**
 * 저장한다. `path` 를 주면 그 이름으로 저장한다(다른 이름으로 저장 — 바깥 수정
 * 검사는 하지 않는다). 경로 없는 새 문서는 `path` 가 있어야 한다.
 */
export async function saveMd(id: string, text: string, path: string | null, force: boolean): Promise<SaveOutcome> {
  const entry = entries.get(id);
  if (!entry?.md) return { ok: false, conflict: false, message: "Markdown 문서가 아닙니다." };
  const target = path ?? entry.view.path;
  if (target === "") return { ok: false, conflict: false, message: "저장할 위치가 없습니다." };

  const meta = path === null ? entry.md : { ...entry.md, mtimeMs: 0 };
  const outcome = await writeMd(target, text, meta, force || path !== null);
  if (outcome.ok) {
    entry.view.path = target;
    entry.view.name = basename(target);
    setMd(entry, text, outcome.meta, outcome.size);
    emit();
  }
  return outcome;
}

/** md 의 [다시 읽기]. 바깥에서 고친 내용을 받아 온다. */
async function reloadMd(entry: Entry): Promise<void> {
  if (entry.view.path === "") return;
  try {
    const read = await readMd(entry.view.path);
    setMd(entry, read.text, read.meta, read.size);
  } catch (error) {
    entry.view.snippet = `다시 읽지 못했습니다: ${(error as Error).message}`;
  }
  emit();
}

/** 옵션을 바꿔 다시 넣는다. 진행 중이면 먼저 취소한다. */
export function reconvert(id: string, options?: DocOptions): void {
  const entry = entries.get(id);
  if (!entry) return;
  if (entry.md) return void reloadMd(entry);

  entry.abort?.abort();
  if (options) entry.view.options = options;
  entry.view.status = "queued";
  entry.view.result = null;
  entry.view.snippet = "대기 중입니다.";
  entry.markdown = "";

  if (!pending.includes(id)) pending.push(id);
  emit();
  pump();
}

export function cancel(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;

  entry.abort?.abort();
  const at = pending.indexOf(id);
  if (at >= 0) pending.splice(at, 1);

  if (entry.view.status !== "done") {
    entry.view.status = "failed";
    entry.view.snippet = "사용자가 취소했습니다.";
    entry.view.result = {
      ok: false,
      warnings: [],
      log: [{ label: "취소", value: "사용자 요청" }],
      meta: { engine: "-", elapsedMs: 0 },
      error: { code: "CANCELLED", message: "변환을 취소했습니다.", actions: ["retry-plain"] },
    };
  }
  emit();
  pump();
}

/** 빈 자리가 있는 만큼 다음 문서를 집어 돌린다. */
function pump(): void {
  const limit = settings().concurrency;

  while (running < limit && pending.length > 0) {
    const id = pending.shift();
    const entry = id ? entries.get(id) : undefined;
    if (!entry) continue;

    running += 1;
    void run(entry).finally(() => {
      running -= 1;
      pump();
    });
  }
}

/** 진행 이벤트를 얼마나 자주 내보낼지. 더 자주 보내도 사람이 알아채지 못한다. */
const PROGRESS_MS = 250;

async function run(entry: Entry): Promise<void> {
  const controller = new AbortController();
  entry.abort = controller;
  entry.view.status = "run";
  entry.view.snippet = "변환하는 중…";
  entry.view.startedAt = Date.now();
  delete entry.view.progress;
  delete entry.view.chars;
  emit();

  // 어댑터가 글자 단위로 부를 수 있어(LLM 스트림) 그대로 흘리면 렌더러가 죽는다.
  let lastEmit = 0;
  const onProgress = (current: number, total: number): void => {
    if (total > 0) entry.view.progress = Math.min(100, Math.round((current / total) * 100));
    else entry.view.chars = current;

    const now = Date.now();
    if (now - lastEmit < PROGRESS_MS) return;
    lastEmit = now;
    emit();
  };

  let result: ParseResult;
  try {
    result = await convert({
      filePath: entry.view.path,
      options: entry.view.options,
      signal: controller.signal,
      onProgress,
    });
  } catch (error) {
    result = {
      ok: false,
      markdown: "",
      warnings: [],
      log: [],
      meta: { engine: "-", elapsedMs: 0 },
      error: {
        code: "RUN_FAILED",
        message: error instanceof Error ? error.message : String(error),
        actions: ["retry-plain"],
      },
    };
  }

  entry.abort = null;

  // 취소된 뒤 늦게 돌아온 결과는 버린다 — cancel() 이 이미 상태를 정해 놨다.
  if (controller.signal.aborted) return;

  const { markdown, ...rest } = result;
  entry.markdown = markdown;
  entry.view.result = rest;
  delete entry.view.progress;
  delete entry.view.chars;
  entry.view.status = result.ok ? "done" : "failed";
  entry.view.snippet = snippetOf(result, markdown);
  emit();
}

/* ── 내보내기 ─────────────────────────────────────────── */

function frontmatterFor(view: DocView): string {
  const lines = [
    "---",
    `title: ${view.name.replace(/\.[^.]+$/, "")}`,
    `source: ${view.name}`,
    ...(view.result?.meta.pages === undefined ? [] : [`pages: ${view.result.meta.pages}`]),
    `engine: ${view.result?.meta.engine ?? "-"}`,
    `converted_at: ${new Date().toISOString()}`,
    "---",
    "",
  ];
  return lines.join("\n");
}

/** 같은 이름이 있으면 -1, -2 를 붙인다. 덮어쓰지 않는다. */
async function freeName(dir: string, base: string): Promise<string> {
  for (let n = 0; n < 1000; n++) {
    const name = n === 0 ? `${base}.md` : `${base}-${n}.md`;
    try {
      await stat(join(dir, name));
    } catch {
      return join(dir, name);
    }
  }
  return join(dir, `${base}-${Date.now()}.md`);
}

export async function exportDocs(request: ExportRequest): Promise<ExportResult> {
  const targets =
    request.ids.length > 0
      ? request.ids.map((id) => entries.get(id)).filter((e): e is Entry => e !== undefined)
      : [...entries.values()].filter((e) => e.view.status === "done");

  let written = 0;
  let failed = 0;

  for (const entry of targets) {
    if (entry.view.status !== "done" || entry.markdown === "") {
      failed += 1;
      continue;
    }

    const body = request.frontmatter ? frontmatterFor(entry.view) + entry.markdown : entry.markdown;
    try {
      // BOM 없는 UTF-8. Node 의 "utf8" 은 BOM 을 붙이지 않는다.
      await writeFile(await freeName(request.outputDir, entry.view.name.replace(/\.[^.]+$/, "")), body, "utf8");
      written += 1;
    } catch {
      failed += 1;
    }
  }

  return { written, failed, outputDir: request.outputDir };
}

/** 앱이 닫힐 때 돌고 있는 자바 프로세스를 남기지 않는다. */
export function shutdown(): void {
  for (const entry of entries.values()) entry.abort?.abort();
}

/** 명령줄로 받은 문서. 탐색기의 "연결 프로그램"으로 열 때 들어온다. */
export async function initialPaths(): Promise<string[]> {
  const candidates = process.argv.slice(1).filter((arg) => !arg.startsWith("-"));
  const found: string[] = [];
  for (const path of candidates) found.push(...(await expand(path, true)));
  return found;
}
