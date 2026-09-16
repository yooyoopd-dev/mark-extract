/**
 * Gemini CLI.
 *
 * 줄 단위 스트림이 아니라 끝에 JSON 하나를 내놓는다. 그래서 줄마다 파싱을
 * 시도하기보다 마지막에 전체를 한 번 읽는 편이 맞지만, 계약을 맞추기 위해
 * 줄 단위로 받아 두었다가 JSON 이 완성되는 줄에서 본문을 꺼낸다.
 */
import { remember, type ParseState, type Provider, type SpawnOptions } from "../types";

/** 응답 JSON 에서 본문이 있을 만한 자리. 버전마다 조금씩 다르다. */
function bodyOf(parsed: unknown): string {
  const o = parsed as Record<string, unknown>;
  for (const key of ["response", "text", "output", "content"]) {
    const value = o?.[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

export const gemini: Provider = {
  id: "gemini",
  label: "Gemini CLI",
  supportsModeA: true,

  args: ({ model, mode }: SpawnOptions): string[] => {
    const args = [
      // 새 디렉터리에서 신뢰 여부를 묻지 않게 한다. 모드 A 의 임시 폴더가 매번 새 경로다.
      "--skip-trust",
      // 파일을 읽되 쓰지는 못하게 한다.
      "--approval-mode", "plan",
      "-o", "json",
    ];
    if (model) args.push("-m", model);
    void mode;
    return args;
  },

  consume: (line: string, state: ParseState): string | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      remember(state, line);
      return null;
    }

    const body = bodyOf(parsed);
    if (body === "") {
      remember(state, line);
      return null;
    }
    // 한 번에 전체가 오므로 이미 내보낸 만큼을 잘라 낸다.
    const rest = body.startsWith(state.emitted) ? body.slice(state.emitted.length) : body;
    state.emitted = body;
    return rest === "" ? null : rest;
  },
};
