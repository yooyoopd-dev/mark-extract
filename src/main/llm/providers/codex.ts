/**
 * Codex CLI.
 *
 * 줄 단위 JSON 이벤트를 내놓는다. 본문은 에이전트 메시지 이벤트에 실린다.
 * `--sandbox read-only` 가 이미 읽기 전용이라 모드 A 격리에 더 붙일 것이 적다.
 */
import { remember, type ParseState, type Provider, type SpawnOptions } from "../types";

function deltaOf(event: Record<string, unknown>): string | null {
  const type = String(event["type"] ?? "");
  // 증분과 완성본이 모두 올 수 있다. 증분을 우선한다.
  if (type.endsWith("agent_message_delta") || type.endsWith("output_text.delta")) {
    const text = event["delta"] ?? event["text"];
    return typeof text === "string" ? text : null;
  }
  return null;
}

function wholeOf(event: Record<string, unknown>): string | null {
  const type = String(event["type"] ?? "");
  if (type.endsWith("agent_message") || type.endsWith("output_text.done")) {
    const message = event["message"] ?? event["text"];
    return typeof message === "string" ? message : null;
  }
  return null;
}

export const codex: Provider = {
  id: "codex",
  label: "Codex CLI",
  supportsModeA: true,

  args: ({ model, mode }: SpawnOptions): string[] => {
    const args = [
      // 승인 요청 없이 돈다. 사람이 앉아 있지 않다.
      "-a", "never",
      "exec",
      "--json",
      "--sandbox", "read-only",
      // 세션을 남기지 않는다.
      "--ephemeral",
    ];
    if (model) args.push("--model", model);
    void mode;
    // 프롬프트를 stdin 으로 받는다.
    args.push("-");
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

    const delta = deltaOf(event);
    if (delta !== null) {
      state.sawDelta = true;
      state.emitted += delta;
      return delta;
    }

    const whole = wholeOf(event);
    if (whole === null) {
      remember(state, line);
      return null;
    }
    // claude 와 같은 문제 — 증분을 본 뒤의 완성본은 반복이다.
    if (state.sawDelta) return null;
    const rest = whole.startsWith(state.emitted) ? whole.slice(state.emitted.length) : whole;
    state.emitted = whole;
    return rest === "" ? null : rest;
  },
};
