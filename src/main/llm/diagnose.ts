/**
 * CLI 가 실패했을 때 원인을 찾는다 (docs/design/03-llm-engine.md#오류-진단).
 *
 * 사내망 PC 는 로그를 반출할 수 없다. 화면에 뜨는 것이 전부이므로 "실패했습니다"로
 * 끝내지 않고 어디를 봤는지까지 남긴다.
 */
import type { ParseError } from "../../shared/parse";

/** 파싱하지 못한 줄을 모을 상한. 종료 직전 줄이 이유를 말하므로 뒤에서부터 채운다. */
const UNPARSED_BUDGET = 4096;

/** 인증 만료는 다른 실패와 조치가 전혀 달라 따로 승격한다. */
const AUTH_PATTERNS = [
  /unauthenticated/i,
  /\boauth\b/i,
  /failed to authenticate/i,
  /authentication (failed|required|expired)/i,
  /not logged in/i,
  /please (run )?login/i,
  /invalid api key/i,
  // gemini 0.60.0 실측 — "Please set an Auth method in your .../settings.json"
  /set an auth method/i,
];

export function looksUnauthenticated(text: string): boolean {
  return AUTH_PATTERNS.some((p) => p.test(text));
}

/** 뒤에서부터 예산만큼 담는다. 마지막 줄이 가장 쓸모 있다. */
export function tailJoin(lines: readonly string[], budget = UNPARSED_BUDGET): string {
  const out: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (size + line.length > budget) break;
    out.unshift(line);
    size += line.length;
  }
  return out.join("\n");
}

export interface Failure {
  readonly provider: string;
  readonly command: string;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly unparsed: readonly string[];
  /** 본문을 한 글자도 받지 못했는가. */
  readonly empty: boolean;
}

export function diagnose(failure: Failure): ParseError {
  const stderr = failure.stderr.trim();
  const unparsed = tailJoin(failure.unparsed);

  // 1) 인증 — 앱이 대신 로그인해 줄 수 없으므로 가장 먼저 가른다.
  if (looksUnauthenticated(`${stderr}\n${unparsed}`)) {
    return {
      code: "LLM_UNAUTHENTICATED",
      message:
        `${failure.provider} CLI 인증이 만료되었습니다. 터미널에서 ${failure.provider} 를 실행해 ` +
        "로그인한 뒤 재시도하세요. 앱이 대신 로그인해 줄 수는 없습니다.",
      actions: ["retry-plain"],
    };
  }

  // 2) 종료 코드는 0 인데 본문이 비었다. 성공으로 넘기면 빈 파일이 저장되고
  //    사용자는 나중에야 안다.
  if (failure.exitCode === 0 && failure.empty) {
    return {
      code: "LLM_EMPTY_OUTPUT",
      message:
        "CLI 는 정상 종료했지만 본문을 한 글자도 내놓지 않았습니다. " +
        (unparsed === ""
          ? "프롬프트가 거부되었거나 모델이 응답하지 않은 것으로 보입니다."
          : `마지막 출력: ${unparsed.slice(-300)}`),
      actions: ["retry-plain", "retry-mode-b"],
    };
  }

  // 3) stderr — 정석 위치
  if (stderr !== "") {
    return {
      code: "LLM_FAILED",
      message: `${failure.provider} 가 ${failure.exitCode} 로 끝났습니다: ${stderr.slice(-500)}`,
      actions: ["retry-plain", "retry-mode-b"],
    };
  }

  // 4) 파싱하지 못한 stdout — CLI 가 진단을 JSON 채널로 흘리는 경우가 있다
  if (unparsed !== "") {
    return {
      code: "LLM_FAILED",
      message: `${failure.provider} 가 ${failure.exitCode} 로 끝났습니다. 마지막 출력: ${unparsed.slice(-500)}`,
      actions: ["retry-plain", "retry-mode-b"],
    };
  }

  // 5) 둘 다 비었다 — 재현 방법을 안내한다
  return {
    code: "LLM_SILENT",
    message:
      `${failure.provider} 가 아무 출력 없이 ${failure.exitCode} 로 끝났습니다. ` +
      `터미널에서 직접 실행해 보세요: ${failure.command}`,
    actions: ["retry-plain", "retry-mode-b"],
  };
}
