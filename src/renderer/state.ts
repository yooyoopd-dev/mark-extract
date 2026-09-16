/**
 * 렌더러 상태.
 *
 * 문서 목록은 아직 렌더러가 들고 있다. 5단계에서 main 의 변환 큐로 옮기면서
 * 감시 폴더와 영속화가 붙는다.
 */
import type { ParseResult } from "../shared/parse";

export type DocStatus = "queued" | "run" | "done" | "failed";
export type DocKind = "pdf" | "docx" | "xlsx" | "xls" | "pptx";
export type Tab = "render" | "source" | "log";
export type Sort = "modified" | "name" | "size";

export interface Doc {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly kind: DocKind;
  readonly size: number;
  status: DocStatus;
  star: boolean;
  /** 변환 결과. 아직 돌리지 않았으면 null */
  result: ParseResult | null;
  addedAt: number;
}

export interface State {
  view: string;
  selected: string | null;
  query: string;
  status: DocStatus | "all";
  sort: Sort;
  tab: Tab;
  theme: "system" | "light" | "dark";
  /** 좁은 창에서 목록/뷰어 중 무엇을 보일지 */
  pane: "list" | "viewer";
}

export const docs: Doc[] = [];

export const state: State = {
  view: "all",
  selected: null,
  query: "",
  status: "all",
  sort: "modified",
  tab: "render",
  theme: "system",
  pane: "list",
};

export const KIND_LABEL: Record<DocKind, string> = {
  pdf: "PDF",
  docx: "DOC",
  xlsx: "XLS",
  xls: "XLS",
  pptx: "PPT",
};

export const STATUS = {
  done: { label: "완료", icon: "i-check", cls: "done" },
  run: { label: "변환중", icon: "i-loader", cls: "run" },
  queued: { label: "대기", icon: "i-clock", cls: "queued" },
  failed: { label: "실패", icon: "i-alert", cls: "failed" },
} as const satisfies Record<DocStatus, { label: string; icon: string; cls: string }>;

/** 확장자로 짐작한다. 실제 판별은 main 이 매직 바이트로 하고, 결과에 따라 갱신된다. */
export function kindOf(name: string): DocKind | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return ext === "pdf" || ext === "docx" || ext === "xlsx" || ext === "xls" || ext === "pptx" ? ext : null;
}

let seq = 0;
export function addDoc(path: string, name: string, size: number, kind: DocKind): Doc {
  const doc: Doc = {
    id: `d${++seq}`,
    name,
    path,
    kind,
    size,
    status: "queued",
    star: false,
    result: null,
    addedAt: Date.now(),
  };
  docs.push(doc);
  return doc;
}

export const getDoc = (id: string | null): Doc | null => docs.find((d) => d.id === id) ?? null;

export const counts = () => ({
  queue: docs.filter((d) => d.status === "queued" || d.status === "run").length,
  all: docs.length,
  done: docs.filter((d) => d.status === "done").length,
  failed: docs.filter((d) => d.status === "failed").length,
  star: docs.filter((d) => d.star).length,
  pdf: docs.filter((d) => d.kind === "pdf").length,
  docx: docs.filter((d) => d.kind === "docx").length,
  xlsx: docs.filter((d) => d.kind === "xlsx" || d.kind === "xls").length,
  pptx: docs.filter((d) => d.kind === "pptx").length,
});

const VIEWS: Record<string, { title: string; test: (d: Doc) => boolean }> = {
  queue: { title: "변환 큐", test: (d) => d.status === "queued" || d.status === "run" },
  all: { title: "전체 문서", test: () => true },
  done: { title: "완료", test: (d) => d.status === "done" },
  failed: { title: "실패", test: (d) => d.status === "failed" },
  star: { title: "즐겨찾기", test: (d) => d.star },
};

export function viewDef(view: string): { title: string; test: (d: Doc) => boolean } {
  const known = VIEWS[view];
  if (known) return known;

  if (view.startsWith("kind:")) {
    const kind = view.slice(5) as DocKind;
    const label = KIND_LABEL[kind] ?? "문서";
    return {
      title: `${label} 문서`,
      test: (d) => (kind === "xlsx" ? d.kind === "xlsx" || d.kind === "xls" : d.kind === kind),
    };
  }
  return VIEWS["all"]!;
}

const ORDER: Record<DocStatus, number> = { run: 0, queued: 1, failed: 2, done: 3 };

export function visibleDocs(): Doc[] {
  const def = viewDef(state.view);
  const q = state.query.trim().toLowerCase();

  const list = docs.filter(
    (d) =>
      def.test(d) &&
      (state.status === "all" || d.status === state.status) &&
      (!q || d.name.toLowerCase().includes(q) || (d.result?.markdown ?? "").toLowerCase().includes(q)),
  );

  if (state.sort === "name") list.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  else if (state.sort === "size") list.sort((a, b) => b.size - a.size);
  else list.sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.addedAt - a.addedAt);

  return list;
}
