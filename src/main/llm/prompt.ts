/**
 * LLM 프롬프트.
 *
 * 한 곳에 모아 둔다. 설정 화면이 전문을 열람·복사할 수 있어야 하기 때문이다
 * (결정 25 — 앱은 열람·복사만 제공하고 승인 절차는 조직 소관이다).
 */
import type { InputMode } from "../../shared/parse";

export type OutputLanguage = "ko" | "en" | "keep";

const LANGUAGE: Record<OutputLanguage, string> = {
  ko: "출력은 한국어로 작성한다.",
  en: "Write the output in English.",
  keep: "원문의 언어를 그대로 유지한다. 번역하지 않는다.",
};

/** 두 모드가 공유하는 규약. */
const RULES = [
  "너는 문서를 Markdown 으로 옮기는 변환기다.",
  "",
  "규칙:",
  "- Markdown 외에 아무것도 출력하지 않는다. 설명·머리말·맺음말·사과를 붙이지 않는다.",
  "- 전체를 코드 펜스로 감싸지 않는다.",
  "- 원문에 없는 내용을 지어내지 않는다. 읽어 낼 수 없는 부분은 비워 두고 넘어간다.",
  "- 제목 계층(#, ##, ###)과 표는 원문의 구조를 따른다.",
  "- 표는 GitHub Flavored Markdown 표로 쓴다.",
  // 로컬 파서는 그림을 글자로 만들지 못한다. 파일을 직접 읽는 모드 A 의 비전 CLI 는
  // 할 수 있으므로, 파일 참조로 흘리지 말고 내용을 쓰게 한다 — 참조 경로는 우리에게
  // 도달하지 않아 어디도 가리키지 못한다 (image-notes.ts).
  "- 그림·도표는 내용을 글로 옮긴다. `![](파일경로)` 같은 파일 참조는 쓰지 않는다.",
];

/**
 * 읽지 못했을 때 내놓을 표식.
 *
 * 길이로 짐작하지 않는다 — 짧은 문서와 거절을 가를 수 없고, 거절 문구는 모델마다
 * 다르다. 정확한 한 마디를 요구하고 그것만 본다 (결정 17).
 */
export const CANNOT_READ = "MARKEXTRACT_CANNOT_READ";

export function buildPrompt(mode: InputMode, language: OutputLanguage, fileName: string): string {
  const head = [...RULES, `- ${LANGUAGE[language]}`, ""];

  if (mode === "A") {
    return [
      ...head,
      `작업 디렉터리에 있는 \`${fileName}\` 한 개를 읽어 Markdown 으로 옮겨라.`,
      "",
      `파일을 열 수 없거나 그 형식을 다루지 못하면, 설명 없이 \`${CANNOT_READ}\` 한 줄만 출력하고 멈춘다.`,
      "추측으로 채우지 않는다. 읽지 못한 것을 읽은 척하지 않는다.",
    ].join("\n");
  }

  return [
    ...head,
    "아래는 로컬 파서가 뽑아낸 Markdown 이다. 구조·제목 계층·표를 다듬어 다시 내놓아라.",
    "없는 정보를 복원하려 하지 마라 — 로컬 파서가 놓친 것은 너도 알 수 없다.",
    "",
    "--- 입력 시작 ---",
  ].join("\n");
}

/** 프롬프트 전문. 설정 화면이 이것을 그대로 띄운다 (6b). */
export function promptText(mode: InputMode, language: OutputLanguage): string {
  return buildPrompt(mode, language, "<문서파일>");
}
