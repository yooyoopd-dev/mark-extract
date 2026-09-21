/**
 * 못 읽은 그림을 위치 표시 줄로 바꾼다 (docs/design/02-parser-adapters.md).
 *
 * 네 어댑터가 모두 그림을 **파일 참조**로 내놓는다.
 *
 *   opendataloader  ![](<이름_images/imageFile1.png>)   ← 꺾쇠로 감싼다 (실측)
 *   kordoc          ![image](경로)
 *   pptx.ts         ![alt](media/image1.png)
 *
 * 그런데 그 파일은 변환 1건짜리 임시 디렉터리에 쓰였다가 통째로 지워진다. 즉 남는
 * 것은 **어디도 가리키지 않는 링크**뿐이고, 사용자 화면에는 `이미지 참조 · 경로`
 * 라는 쓸 데 없는 칩만 줄줄이 붙었다 (build.29 실측 보고).
 *
 * 그래서 참조를 지우고 그 자리에 **원본 어디였는지**를 남긴다. 그림 내용을 글자로
 * 만들 수 있는 경로는 따로 있고(OCR = 스캔된 글자, LLM 모드 A = 비전 CLI), 로컬
 * 파서가 할 수 있는 것은 못 읽었다는 사실과 그 위치를 정확히 말하는 것뿐이다.
 */
import type { Warning } from "../shared/parse";

/** off = 그림 자리를 아예 남기지 않는다, note = 위치 표시 줄로 바꾼다 */
export type ImageMode = "note" | "off";

/**
 * PDF 어댑터가 `--markdown-page-separator` 로 엔진에 넘기는 구분자.
 *
 * 엔진이 `%page-number%` 를 채워 **1쪽 포함 매 쪽 앞에** 한 줄로 넣는다(실측).
 * 여기서 읽고 나면 본문에서 지운다 — 사용자 결과물에 남길 것이 아니다.
 */
export const PAGE_SEPARATOR = "<!-- markextract-page %page-number% -->";

const PAGE_LINE = /^\s*<!--\s*markextract-page\s+(\d+)\s*-->\s*$/;
/** pptx.ts 가 이미 내는 슬라이드 경계. 이쪽은 지우지 않는다 — 원본 구조다. */
const SLIDE_LINE = /^\s*<!--\s*Slide number:\s*(\d+)\s*-->\s*$/;
const HEADING = /^\s*#{1,6}\s+(.+?)\s*$/;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;

/** 제목을 위치 표시에 넣을 때의 길이 제한. 한 줄이 길어지면 읽기 어렵다. */
const HEADING_MAX = 30;

export interface ImageNotes {
  readonly markdown: string;
  readonly warnings: readonly Warning[];
}

/**
 * 그림 참조를 걷어 낸다.
 *
 * 위치는 세 가지를 순서대로 본다: 페이지 구분자(PDF) → 슬라이드 경계(PPTX) →
 * 가장 가까운 앞선 제목(DOCX·XLSX 는 쪽 개념이 없다. XLSX 는 시트 이름이 `##` 로
 * 나오므로 이것이 시트를 가리킨다).
 */
export function noteImages(markdown: string, mode: ImageMode): ImageNotes {
  const out: string[] = [];
  const pages: number[] = [];
  let count = 0;

  let page: number | null = null;
  let pageUnit = "쪽";
  let heading: string | null = null;

  for (const line of markdown.split("\n")) {
    const pageMark = PAGE_LINE.exec(line);
    if (pageMark?.[1]) {
      page = Number(pageMark[1]);
      pageUnit = "쪽";
      // 본문에서는 뺀다. 다음 줄로 넘어가기 전에 push 하지 않는다.
      continue;
    }

    const slideMark = SLIDE_LINE.exec(line);
    if (slideMark?.[1]) {
      page = Number(slideMark[1]);
      pageUnit = "번째 슬라이드";
      // 슬라이드는 닫힌 칸이라 앞 슬라이드의 제목이 넘어오면 거짓이 된다 — 제목
      // 없는 2번 슬라이드의 그림이 `"1. 첫째 슬라이드" 아래` 로 나왔다(실측).
      // PDF 쪽 경계에서는 지우지 않는다. 쪽이 넘어가도 그 제목은 계속 유효하다.
      heading = null;
      out.push(line);
      continue;
    }

    const title = HEADING.exec(line);
    if (title?.[1]) heading = title[1];

    IMAGE.lastIndex = 0;
    if (!IMAGE.test(line)) {
      out.push(line);
      continue;
    }

    if (mode === "off") {
      const stripped = line.replace(IMAGE, "");
      // 그림만 있던 줄은 통째로 뺀다. 빈 줄만 남기면 문단 사이가 벌어진다.
      if (stripped.trim() !== "" || line.trim() === "") out.push(stripped);
      continue;
    }

    // 줄 전체가 그림 하나면 인용 줄로 바꾼다. `>` 로 시작해야 normalize.ts 의
    // joinWrappedLines 가 이 줄을 앞 문단에 붙이지 않는다 — 지금 `![](…)` 줄은
    // 블록으로 치지 않아 실제로 붙는다.
    const alone = line.trim().replace(IMAGE, "") === "";
    if (alone) {
      count += 1;
      if (page !== null && !pages.includes(page)) pages.push(page);
      out.push(`> ${label(count)} ${where(page, pageUnit, heading)}`);
      continue;
    }

    // 표 셀처럼 다른 내용과 한 줄에 섞여 있으면 인용 줄을 넣을 수 없다.
    out.push(
      line.replace(IMAGE, () => {
        count += 1;
        if (page !== null && !pages.includes(page)) pages.push(page);
        return label(count);
      }),
    );
  }

  return { markdown: out.join("\n"), warnings: summary(count, pages, pageUnit) };
}

const label = (n: number): string => `[그림 ${n}]`;

function where(page: number | null, unit: string, heading: string | null): string {
  const parts: string[] = [];
  if (page !== null) parts.push(`${page}${unit}`);
  if (heading !== null) {
    const text = heading.length > HEADING_MAX ? `${heading.slice(0, HEADING_MAX)}…` : heading;
    parts.push(`"${text}" 아래`);
  }
  const at = parts.join(" · ");
  return at === "" ? "내용을 글자로 옮기지 못했습니다." : `${at} — 내용을 글자로 옮기지 못했습니다.`;
}

/**
 * 경고는 한 건으로 묶는다.
 *
 * 그림마다 한 건씩 내면 그림 50개짜리 문서에서 경고 탭이 쓸모없어진다. 정확한
 * 위치는 본문의 `[그림 N]` 줄이 들고 있으므로, 경고는 몇 개를 어느 쪽에서 놓쳤고
 * 무엇을 하면 되는지만 말한다.
 */
function summary(count: number, pages: readonly number[], unit: string): Warning[] {
  if (count === 0) return [];
  const at = pages.length === 0 ? "" : ` (${[...pages].sort((a, b) => a - b).join(", ")}${unit})`;
  return [
    {
      code: "IMAGE_NOT_EXTRACTED",
      message:
        `그림 ${count}개의 내용을 글자로 옮기지 못했습니다${at}. 본문의 [그림 N] 줄이 원본 위치입니다. ` +
        "스캔된 글자는 OCR 을, 사진·차트 설명은 LLM 엔진 모드 A 를 쓰세요.",
    },
  ];
}
