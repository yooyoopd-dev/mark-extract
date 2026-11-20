/**
 * Claude Code CLI.
 *
 * `--verbose` 가 켜져 있으면 두 종류의 이벤트가 섞여 온다.
 *
 *   stream_event → content_block_delta → text_delta : 진짜 증분
 *   assistant                                       : 진행 중인 메시지 전체를 매번 다시 보냄
 *
 * 둘을 그대로 이어 붙이면 내용이 중복된다. 증분을 한 번이라도 본 뒤에는 assistant 를
 * 무시하고, 증분이 오지 않는 버전에서는 assistant 의 이미 내보낸 접두사를 잘라낸
 * 나머지만 내보낸다.
 *
 * verbose 를 끄면 되지 않느냐 싶지만, stream-json 출력 형식이 --verbose 를 요구한다.
 */
import { remember, type ParseState, type Provider, type SpawnOptions } from "../types";

/** 사용자 훅의 stdout 을 통째로 실어 오는 이벤트. 진단에 쓸모가 없고 버퍼만 먹는다. */
const NOISE = new Set(["hook_started", "hook_response"]);

function textOf(block: unknown): string {
  const b = block as { type?: unknown; text?: unknown };
  return b?.type === "text" && typeof b.text === "string" ? b.text : "";
}

/** assistant 이벤트가 싣고 오는 "현재까지의 전체 메시지". */
function wholeMessage(event: Record<string, unknown>): string {
  const message = event["message"] as { content?: unknown } | undefined;
  const content = message?.content;
  return Array.isArray(content) ? content.map(textOf).join("") : "";
}

function deltaText(event: Record<string, unknown>): string | null {
  const inner = event["event"] as { type?: unknown; delta?: unknown } | undefined;
  if (inner?.type !== "content_block_delta") return null;

  const delta = inner.delta as { type?: unknown; text?: unknown } | undefined;
  return delta?.type === "text_delta" && typeof delta.text === "string" ? delta.text : null;
}

export const claude: Provider = {
  id: "claude",
  label: "Claude Code",
  supportsModeA: true,

  args: ({ model, mode }: SpawnOptions): string[] => {
    const args = [
      "-p",
      "--output-format", "stream-json",
      // --input-format stream-json 은 쓰지 않는다. 그것을 켜면 stdin 도
      // stream-json 이어야 해서 평문 프롬프트가 "Error parsing streaming input
      // line" 으로 거절된다 (실제 CLI 2.1.273 으로 확인). -p 는 평문 stdin 을
      // 그대로 프롬프트로 받는다.
      //
      // stream-json 출력이 이것을 요구한다. 중복 제거가 필요한 이유이기도 하다.
      "--verbose",
      // 사용자의 개인 설정·세션·슬래시 명령이 변환에 끼어들지 않게 한다.
      "--setting-sources", "project",
      "--disable-slash-commands",
      "--no-session-persistence",
    ];
    if (model) args.push("--model", model);

    if (mode === "A") {
      // 읽기 전용 프로필. 도구를 전부 막으면 파일을 열지 못하므로 읽는 것만 남긴다.
      //
      // --permission-mode plan 을 먼저 시도했는데 승인을 기다리느라 끝나지 않았다
      // (실제 CLI 2.1.273 으로 확인). 사람이 앉아 있지 않으므로 묻지 않게 하고,
      // 대신 허용 목록을 읽기 도구로 좁힌다. 볼 수 있는 범위는 작업 디렉터리인
      // 임시 폴더뿐이다 — --add-dir 를 주지 않으므로 바깥으로 나가지 못한다.
      args.push("--allowedTools", "Read", "Glob", "Grep");
      args.push("--disallowedTools", "Bash", "Edit", "Write", "WebFetch", "WebSearch", "Task");
      args.push("--permission-mode", "dontAsk");
    }
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

    const type = event["type"];
    if (type === "system") {
      if (!NOISE.has(String(event["subtype"] ?? ""))) remember(state, line);
      return null;
    }

    if (type === "stream_event") {
      const text = deltaText(event);
      if (text === null) return null;
      state.sawDelta = true;
      state.emitted += text;
      return text;
    }

    if (type === "assistant") {
      // 증분을 본 적이 있으면 이 이벤트는 이미 받은 것의 반복이다.
      if (state.sawDelta) return null;

      const whole = wholeMessage(event);
      if (whole === "") return null;
      // 증분이 오지 않는 버전. 이미 내보낸 만큼을 잘라낸 나머지만 내보낸다.
      if (!whole.startsWith(state.emitted)) {
        // 접두사가 어긋나면 메시지가 갈린 것이다. 통째로 새로 시작한다.
        state.emitted = whole;
        return whole;
      }
      const rest = whole.slice(state.emitted.length);
      state.emitted = whole;
      return rest === "" ? null : rest;
    }

    // result·user 등은 본문이 아니다. 진단에는 남겨 둔다.
    if (type !== "user") remember(state, line);
    return null;
  },
};
