/**
 * Codex CLI (0.154.0 실측).
 *
 * `codex exec --json` 이 줄 단위 JSON 이벤트를 낸다. 실제로 받아 본 첫 줄들:
 *
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *
 * 본문은 `item.completed` 의 `item.type === "agent_message"` 에 실린다. 다만 그
 * 줄까지는 인증 없이 확인하지 못했으므로 `--output-last-message` 를 같이 건다 —
 * 이벤트에서 한 글자도 못 건지면 실행기가 그 파일을 읽는다 (run.ts).
 *
 * `--skip-git-repo-check` 가 없으면 **git 저장소 밖에서 아예 시작하지 않는다**
 * (실측: "Not inside a trusted directory and --skip-git-repo-check was not
 * specified."). 모드 A 의 임시 폴더도, 사용자 PC 의 문서 폴더도 저장소가 아니다.
 */
import { remember, type ParseState, type Provider, type SpawnOptions } from "../types";

/** 본문을 싣고 오는 항목인가. */
function agentText(event: Record<string, unknown>): string | null {
  const type = String(event["type"] ?? "");
  if (type !== "item.completed" && type !== "item.updated") return null;

  const item = event["item"];
  if (typeof item !== "object" || item === null) return null;
  const record = item as Record<string, unknown>;
  if (record["type"] !== "agent_message") return null;

  const text = record["text"];
  return typeof text === "string" && text !== "" ? text : null;
}

export const codex: Provider = {
  id: "codex",
  label: "Codex CLI",
  supportsModeA: true,
  wantsBodyFile: true,

  args: ({ model, mode, bodyFile }: SpawnOptions): string[] => {
    const args = [
      // 승인 요청 없이 돈다. 사람이 앉아 있지 않다.
      "-a", "never",
      "exec",
      "--json",
      "--sandbox", "read-only",
      // 세션을 남기지 않는다.
      "--ephemeral",
      // 저장소 밖에서도 돈다. 이것이 없으면 시작조차 하지 않는다.
      "--skip-git-repo-check",
    ];
    if (model) args.push("--model", model);
    if (bodyFile) args.push("--output-last-message", bodyFile);
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

    const text = agentText(event);
    if (text === null) {
      remember(state, line);
      return null;
    }

    // 같은 항목이 updated → completed 로 두 번 올 수 있다. 이미 낸 만큼을 잘라 낸다.
    const rest = text.startsWith(state.emitted) ? text.slice(state.emitted.length) : text;
    state.emitted = text;
    return rest === "" ? null : rest;
  },
};
