/**
 * 렌더러 상태.
 *
 * 문서 목록은 main 이 들고 있다 (docs/design/01-architecture.md). 여기 있는
 * `docs` 는 main 이 보낸 스냅샷의 사본일 뿐이라 렌더러가 고치지 않는다 —
 * 상태를 바꿀 일은 IPC 로 부탁하고 돌아온 스냅샷을 다시 그린다.
 *
 * 마크다운 본문은 스냅샷에 싣지 않는다(문서당 수백 KB). 선택한 문서 것만
 * doc:markdown 으로 따로 받아 `body` 에 둔다.
 */
import type { DocKind, DocOptions, DocStatus, DocView, WatchFolder } from "../shared/doc";

export type { DocKind, DocOptions, DocStatus, DocView, WatchFolder };
export type Doc = DocView;
export type Tab = "render" | "source" | "log";
export type Sort = "modified" | "name" | "size";
/** 목록 위 칩. 대기와 변환 중은 사용자에게 같은 뜻이라 "진행 중" 하나로 묶는다. */
export type StatusFilter = "all" | "active" | "done" | "failed";

export interface State {
  selected: string | null;
  query: string;
  status: StatusFilter;
  sort: Sort;
  tab: Tab;
  theme: "system" | "light" | "dark";
  /** 좁은 창에서 목록/뷰어 중 무엇을 보일지 */
  pane: "list" | "viewer";
  /** 변환 옵션 패널을 열었는가. 기본은 닫힘 (build.36). */
  inspector: boolean;
  watch: WatchFolder[];
  /** 선택한 문서의 본문. key 가 어긋나면 낡은 것이다. */
  body: { key: string; markdown: string } | null;
  /**
   * 인스펙터에서 만졌지만 아직 재변환하지 않은 옵션. 원본과 다르면 뷰어 위에
   * 경고 띠가 뜬다.
   */
  draft: { id: string; options: DocOptions } | null;
  /** 내보내기 기본값. 설정에서 받아 온다. */
  outputDir: string | null;
  frontmatter: boolean;
  /**
   * hybrid OCR 서버가 살아 있는가 (7단계).
   *
   * 인스펙터 OCR 토글의 자물쇠다. 주소가 적혀 있는 것과 서버가 사는 것은 다르므로
   * 설정에서 연결 테스트를 통과했을 때만 열린다.
   */
  hybridOk: boolean;
}

export const docs: Doc[] = [];

export const state: State = {
  selected: null,
  query: "",
  status: "all",
  sort: "modified",
  tab: "render",
  theme: "system",
  pane: "list",
  inspector: false,
  watch: [],
  body: null,
  draft: null,
  outputDir: null,
  frontmatter: true,
  hybridOk: false,
};

export function setDocs(next: readonly Doc[]): void {
  docs.length = 0;
  docs.push(...next);
}

/**
 * 본문 캐시 열쇠. 재변환하면 상태가 queued → run → done 으로 지나가므로 열쇠가
 * 바뀌고, 그래서 낡은 본문을 다시 쓰지 않는다.
 */
export const bodyKey = (doc: Doc): string => `${doc.id}:${doc.status}`;

export const markdown = (): string => {
  const doc = getDoc(state.selected);
  return doc && state.body?.key === bodyKey(doc) ? state.body.markdown : "";
};

/** 카드와 뷰어 머리에 적는 형식 이름. 확장자 그대로가 가장 덜 헷갈린다. */
export const KIND_LABEL: Record<DocKind, string> = {
  pdf: "PDF",
  docx: "DOCX",
  xlsx: "XLSX",
  xls: "XLS",
  pptx: "PPTX",
  html: "HTML",
  eml: "EML",
};

export const STATUS = {
  done: { label: "완료", icon: "i-check", cls: "done" },
  run: { label: "변환중", icon: "i-loader", cls: "run" },
  queued: { label: "대기", icon: "i-clock", cls: "queued" },
  failed: { label: "실패", icon: "i-alert", cls: "failed" },
} as const satisfies Record<DocStatus, { label: string; icon: string; cls: string }>;

export const getDoc = (id: string | null): Doc | null => docs.find((d) => d.id === id) ?? null;

/** 인스펙터가 보여 줄 옵션 — 손댄 것이 있으면 그것, 없으면 저장된 것. */
export function effectiveOptions(doc: Doc): DocOptions {
  return state.draft?.id === doc.id ? state.draft.options : doc.options;
}

/** 손댄 옵션이 저장된 것과 실제로 다른가. 같은 값으로 되돌리면 경고 띠가 사라진다. */
export function isDirty(doc: Doc): boolean {
  if (state.draft?.id !== doc.id) return false;
  const keys = [
    "tableMethod",
    "includeHeaderFooter",
    "imageOutput",
    "pages",
    "engine",
    "provider",
    "model",
    "inputMode",
    "ocr",
    "hybridFullPages",
    "useStructTree",
  ] as const;
  return keys.some((k) => state.draft?.options[k] !== doc.options[k]);
}

const FILTER: Record<StatusFilter, (d: Doc) => boolean> = {
  all: () => true,
  active: (d) => d.status === "queued" || d.status === "run",
  done: (d) => d.status === "done",
  failed: (d) => d.status === "failed",
};

/** 칩 옆 숫자. 사이드바가 하던 일을 칩이 한다. */
export const counts = (): Record<StatusFilter, number> => ({
  all: docs.length,
  active: docs.filter(FILTER.active).length,
  done: docs.filter(FILTER.done).length,
  failed: docs.filter(FILTER.failed).length,
});

const ORDER: Record<DocStatus, number> = { run: 0, queued: 1, failed: 2, done: 3 };

export function visibleDocs(): Doc[] {
  const q = state.query.trim().toLowerCase();

  // 검색은 이름과 미리보기까지만 본다. 본문 전체는 렌더러에 없다 — 전문 검색이
  // 필요해지면 main 에 채널을 하나 더 여는 쪽이 맞다.
  const list = docs.filter(
    (d) =>
      FILTER[state.status](d) &&
      (!q || d.name.toLowerCase().includes(q) || d.snippet.toLowerCase().includes(q)),
  );

  if (state.sort === "name") list.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  else if (state.sort === "size") list.sort((a, b) => b.size - a.size);
  else list.sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.addedAt - a.addedAt);

  return list;
}
