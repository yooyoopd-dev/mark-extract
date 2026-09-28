/**
 * Ollama 루프백 조회 (결정 15).
 *
 * **본문 생성은 CLI 가 한다.** 여기서 HTTP 를 쓰는 것은 두 가지뿐이다.
 *
 *   설치된 모델 목록   GET  /api/tags   — 설정 화면 드롭다운을 채운다
 *   모델 컨텍스트 길이  POST /api/show   — 입력이 넘치는지 미리 본다
 *
 * 둘 다 루프백이라 외부로 나가는 통신이 아니다. 설정 화면에 그 사실을 적는다.
 *
 * 응답이 없어도 변환은 CLI 단독으로 돌아간다. 다만 컨텍스트를 모르면 입력이 잘려도
 * 알 수 없으므로 그때는 경고를 남긴다 — 조용히 잘리면 사용자는 문서 뒷부분이 통째로
 * 빠진 것을 나중에야 안다.
 */

/** 로컬 데몬이라 오래 기다릴 이유가 없다. 없으면 바로 없는 것이다. */
const TIMEOUT_MS = 3000;

async function get(url: string, body?: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const init: RequestInit = { signal: controller.signal };
    if (body !== undefined) {
      init.method = "POST";
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export interface OllamaModels {
  readonly ok: boolean;
  readonly models: readonly string[];
  /** 화면에 그대로 띄우는 사유. 성공이면 빈 문자열. */
  readonly detail: string;
}

export async function listModels(baseUrl: string): Promise<OllamaModels> {
  try {
    const data = (await get(`${baseUrl.replace(/\/+$/, "")}/api/tags`)) as {
      models?: Array<{ name?: unknown }>;
    };
    const models = (data.models ?? [])
      .map((m) => (typeof m.name === "string" ? m.name : ""))
      .filter((name) => name !== "");
    return { ok: true, models, detail: "" };
  } catch (error) {
    return {
      ok: false,
      models: [],
      detail:
        error instanceof Error && error.name === "AbortError"
          ? `${baseUrl} 가 ${TIMEOUT_MS / 1000}초 안에 응답하지 않았습니다.`
          : `${baseUrl} 에 연결하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 모델의 컨텍스트 길이(토큰). 알 수 없으면 null.
 *
 * /api/show 가 model_info 안에 `<아키텍처>.context_length` 로 담아 준다. 키 이름이
 * 아키텍처마다 달라 접미사로 찾는다.
 */
export async function contextLength(baseUrl: string, model: string): Promise<number | null> {
  try {
    const data = (await get(`${baseUrl.replace(/\/+$/, "")}/api/show`, { model })) as {
      model_info?: Record<string, unknown>;
    };
    for (const [key, value] of Object.entries(data.model_info ?? {})) {
      if (key.endsWith(".context_length") && typeof value === "number" && value > 0) return value;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 입력이 컨텍스트를 넘을지 어림한다.
 *
 * 정확한 토큰 수는 모델의 토크나이저를 돌려야 알 수 있고 우리는 그것을 갖고 있지
 * 않다. 한국어는 글자당 토큰이 영어보다 많아 보수적으로 잡는다 — 넘칠 것을 안
 * 넘친다고 하는 쪽이 그 반대보다 나쁘다.
 */
const CHARS_PER_TOKEN = 1.6;
/** 모델이 답할 자리를 남긴다. */
const RESPONSE_RESERVE = 0.4;

export function looksTooLong(chars: number, context: number): boolean {
  return chars / CHARS_PER_TOKEN > context * (1 - RESPONSE_RESERVE);
}
