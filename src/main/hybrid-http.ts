/**
 * hybrid OCR 서버 연결 테스트 (docs/design/02-parser-adapters.md#ocr과-hybrid-서버).
 *
 * 본문 변환은 Java CLI 가 `--hybrid-url` 로 직접 서버를 부른다. 여기서 HTTP 를
 * 쓰는 것은 **살아 있는지 확인하는 것 하나뿐**이다 — 설정 화면의 연결 테스트와,
 * 인스펙터 OCR 토글을 열어도 되는지 판단하는 데 쓴다.
 *
 * 엔드포인트는 실제 서버를 띄워 확인했다 (Docling Fast Server 1.0.0):
 *
 *   GET /health          → 200 {"status":"ok"}
 *   POST /v1/convert/file  ← Java CLI 가 부르는 곳. 우리는 부르지 않는다
 *
 * ollama-http.ts 와 모양이 같지만 합치지 않는다. 저쪽은 LLM 엔진, 이쪽은 PDF
 * 어댑터의 것이라 적용 범위가 다르다.
 */

/** 살아 있으면 곧바로 답한다. 실측 13ms. */
const TIMEOUT_MS = 3000;

export interface HybridStatus {
  readonly ok: boolean;
  /** 화면에 그대로 띄운다. 성공이면 상태 문자열, 실패면 사유. */
  readonly detail: string;
  /** 왕복 시간(ms). 실패면 0. */
  readonly ms: number;
}

/** 루프백이 아닌 주소인가. PDF 원본이 그 host 로 나간다는 뜻이라 화면에 알려야 한다. */
export function isRemote(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return !(host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]");
  } catch {
    return false;
  }
}

export async function testHybrid(baseUrl: string): Promise<HybridStatus> {
  const url = baseUrl.trim().replace(/\/+$/, "");
  if (url === "") return { ok: false, detail: "주소가 비어 있습니다.", ms: 0 };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();

  try {
    const response = await fetch(`${url}/health`, { signal: controller.signal });
    const ms = Date.now() - started;
    if (!response.ok) return { ok: false, detail: `/health 가 HTTP ${response.status} 를 돌려줬습니다.`, ms };

    // {"status":"ok"} 를 기대하지만, 200 이면 서버는 살아 있는 것이다. 본문 모양이
    // 판올림으로 바뀌어도 연결 자체를 실패로 만들지 않는다.
    const body = (await response.json().catch(() => null)) as { status?: unknown } | null;
    const status = typeof body?.status === "string" ? body.status : "ok";
    return { ok: true, detail: status, ms };
  } catch (error) {
    return {
      ok: false,
      detail:
        error instanceof Error && error.name === "AbortError"
          ? `${url} 가 ${TIMEOUT_MS / 1000}초 안에 응답하지 않았습니다.`
          : `${url} 에 연결하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      ms: 0,
    };
  }
}
