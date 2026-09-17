/**
 * Gemini CLI (0.60.0 실측).
 *
 * `-o json` 은 쓰지 않는다. 그 형식은 **여러 줄로 예쁘게 찍힌 JSON 하나**라
 * 줄 단위로 파싱하는 우리 실행기가 본문을 한 글자도 꺼내지 못한다. 실측:
 *
 *   {\n  "session_id": "...",\n  "error": { ... }\n}
 *
 * `-o stream-json` 은 한 줄에 이벤트 하나인 JSONL 이다. 본문은 이렇게 온다
 * (CLI 번들에서 확인한 방출 지점 그대로):
 *
 *   {"type":"message","role":"assistant","content":"...","delta":true}
 *
 * 프롬프트는 stdin 으로 넘어간다. `-p` 는 필요 없다 — stdin 이 파이프면 CLI 가
 * 알아서 헤드리스로 돌고, 받은 stdin 을 사용자 메시지로 그대로 싣는다(실측).
 */
import { remember, type ParseState, type Provider, type SpawnOptions } from "../types";

export const gemini: Provider = {
  id: "gemini",
  label: "Gemini CLI",
  supportsModeA: true,

  args: ({ model, mode }: SpawnOptions): string[] => {
    const args = [
      // 새 디렉터리에서 신뢰 여부를 묻지 않게 한다. 모드 A 의 임시 폴더가 매번 새 경로다.
      "--skip-trust",
      // 파일을 읽되 쓰지는 못하게 한다. `plan` 은 CLI 가 읽기 전용이라고 못박은 값이다.
      "--approval-mode", "plan",
      "-o", "stream-json",
    ];
    if (model) args.push("-m", model);
    void mode;
    return args;
  },

  consume: (line: string, state: ParseState): string | null => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      remember(state, line);
      return null;
    }

    // 우리가 보낸 프롬프트가 사용자 메시지로 되돌아온다. 본문으로 세면 문서 앞에
    // 프롬프트가 통째로 붙는다.
    if (event["role"] === "user") return null;

    const content = event["type"] === "message" && event["role"] === "assistant" ? event["content"] : null;
    if (typeof content !== "string" || content === "") {
      remember(state, line);
      return null;
    }

    if (event["delta"] === true) {
      state.sawDelta = true;
      state.emitted += content;
      return content;
    }

    // 증분을 본 뒤의 완성본은 반복이다 (claude·codex 와 같은 문제).
    if (state.sawDelta) return null;
    const rest = content.startsWith(state.emitted) ? content.slice(state.emitted.length) : content;
    state.emitted = content;
    return rest === "" ? null : rest;
  },
};
