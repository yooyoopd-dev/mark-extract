/** 프로바이더 공통 계약 (docs/design/03-llm-engine.md#프로바이더별-기동). */
import type { InputMode, Provider as ProviderId } from "../../shared/parse";

export interface SpawnOptions {
  /** 빈 값이면 인자에서 --model 을 뺀다. CLI 기본값을 쓴다는 뜻이다. */
  readonly model?: string;
  readonly mode: InputMode;
  /** 본문을 파일로도 받는 프로바이더에게 주는 경로. wantsBodyFile 이 true 일 때만 온다. */
  readonly bodyFile?: string;
}

/**
 * 줄 단위 파서가 들고 다니는 상태.
 *
 * claude 의 중복 제거가 이것을 쓴다. 다른 프로바이더는 손대지 않는다.
 */
export interface ParseState {
  /** 지금까지 내보낸 본문. 접두사 절단에 쓴다. */
  emitted: string;
  /** 진짜 증분 이벤트를 한 번이라도 보았는가. */
  sawDelta: boolean;
  /** 파서가 인식하지 못한 줄. 오류 진단이 뒤에서부터 읽는다. */
  unparsed: string[];
}

export interface Provider {
  readonly id: ProviderId;
  readonly label: string;
  /** stdin 으로 프롬프트를 넘기는가. 전부 그렇지만 명시해 둔다. */
  readonly args: (options: SpawnOptions) => string[];
  /**
   * stdout 한 줄을 받아 내보낼 증분 텍스트를 돌려준다.
   *
   * null 은 "내보낼 것이 없다" 이고, 그 줄이 진단에 쓸모 있으면 구현이
   * state.unparsed 에 직접 담는다.
   */
  readonly consume: (line: string, state: ParseState) => string | null;
  /** 모드 A(파일 직접 읽기)를 할 수 있는가. ollama 는 파일 읽기 도구가 없다. */
  readonly supportsModeA: boolean;
  /**
   * 본문을 파일로도 받는가.
   *
   * codex 는 마지막 메시지를 파일로 써 준다. 이벤트 형식이 판올림으로 바뀌어도
   * 본문을 통째로 잃지 않게 하는 안전망이다.
   */
  readonly wantsBodyFile?: boolean;
}

export function newState(): ParseState {
  return { emitted: "", sawDelta: false, unparsed: [] };
}

/** 파서가 인식하지 못한 줄을 모아 둔다. 상한을 넘으면 앞에서부터 버린다. */
const UNPARSED_MAX = 40;
export function remember(state: ParseState, line: string): void {
  const trimmed = line.trim();
  if (trimmed === "") return;
  state.unparsed.push(trimmed.slice(0, 500));
  if (state.unparsed.length > UNPARSED_MAX) state.unparsed.shift();
}
