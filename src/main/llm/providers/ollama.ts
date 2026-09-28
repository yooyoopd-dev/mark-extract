/**
 * Ollama.
 *
 * 다른 셋과 달리 JSON 이 아니라 평문을 흘린다. 줄을 그대로 본문으로 쓴다.
 *
 * 모드 A 는 할 수 없다 — 파일 읽기 도구가 없어 경로를 줘도 열지 못한다 (결정 15 주변).
 * UI 가 선택 자체를 막고, run.ts 가 한 번 더 거른다.
 *
 * 본문 생성은 CLI 가 하고, 모델 목록·컨텍스트 길이 조회만 localhost:11434 를 쓴다.
 * 그 HTTP 경로는 설정 화면(6b) 몫이라 여기에는 없다.
 */
import type { ParseState, Provider, SpawnOptions } from "../types";

export const ollama: Provider = {
  id: "ollama",
  label: "Ollama (로컬 모델)",
  supportsModeA: false,

  args: ({ model, mode }: SpawnOptions): string[] => {
    void mode;
    // 모델 이름이 필수다. 없으면 run.ts 가 먼저 막는다.
    return ["run", model ?? ""];
  },

  consume: (line: string, state: ParseState): string | null => {
    // 평문이라 인식하지 못할 줄이 없다. 진행 표시(스피너)는 stderr 로 나간다.
    //
    // 실행기가 줄을 끊으면서 개행을 떼어 내므로 여기서 되살린다. 그러지 않으면
    // 문단 경계가 사라져 제목과 본문이 한 줄로 붙는다.
    const text = `${line}\n`;
    state.emitted += text;
    return text;
  },
};
