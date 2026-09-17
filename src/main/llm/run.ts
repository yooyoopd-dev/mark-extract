/**
 * LLM CLI 실행기 (docs/design/03-llm-engine.md).
 *
 * 구조는 pdf-opendataloader.ts 의 runJava() 와 같다: spawn, shell:false,
 * AbortSignal → SIGKILL, 타임아웃, finally 에서 임시 디렉터리 삭제. 5단계에서 이
 * 모양이 취소 검증을 통과했으므로 새로 짜지 않고 따른다.
 */
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeMarkdown } from "../normalize";
import { diagnose } from "./diagnose";
import { buildPrompt, CANNOT_READ, type OutputLanguage } from "./prompt";
import { providerOf } from "./providers";
import { resolveCli } from "./resolve";
import { newState, type ParseState } from "./types";
import type {
  InputMode,
  LogEntry,
  ParseRequest,
  ParseResult,
  Provider as ProviderId,
  RetryAction,
} from "../../shared/parse";

/**
 * LLM 은 로컬 엔진보다 훨씬 오래 걸릴 수 있다. 14B 모델이 CPU 에서 긴 문서를 다시
 * 쓰면 수십 분이 정상이다 (build.8 실측). 10분으로 끊으면 정상 동작을 실패로
 * 만든다.
 */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** 이 시간 동안 한 글자도 오지 않으면 로그에 남긴다. 멈춘 것인지 가늠하는 단서다. */
const SILENT_WARN_MS = 2 * 60 * 1000;

interface RunOutcome {
  readonly code: number | null;
  readonly body: string;
  readonly stderr: string;
  readonly state: ParseState;
  /** 첫 글자가 오기까지 걸린 시간. 한 글자도 못 받았으면 null. */
  readonly firstCharMs: number | null;
}

interface SpawnExtras {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** 받은 글자 수를 올린다. 총량을 모르므로 퍼센트는 만들지 않는다. */
  readonly onChars?: (chars: number) => void;
}

function spawnCli(
  command: string,
  args: readonly string[],
  stdin: string,
  cwd: string | undefined,
  consume: (line: string, state: ParseState) => string | null,
  extras: SpawnExtras = {},
): Promise<RunOutcome> {
  const { signal, onChars } = extras;
  const timeoutMs = extras.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const options: Parameters<typeof spawn>[2] = { shell: false };
    if (cwd !== undefined) options.cwd = cwd;
    const child = spawn(command, [...args], options);

    const state = newState();
    let body = "";
    let stderr = "";
    let pending = "";
    let settled = false;
    let firstCharMs: number | null = null;
    const started = Date.now();

    const grew = (): void => {
      if (firstCharMs === null && body !== "") firstCharMs = Date.now() - started;
      onChars?.(body.length);
    };

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const kill = (): void => {
      child.kill("SIGKILL");
    };
    const onAbort = (): void => {
      kill();
      finish(() => reject(new Error("변환이 취소되었습니다.")));
    };
    const timer = setTimeout(() => {
      kill();
      finish(() => reject(new Error(`변환이 ${Math.round(timeoutMs / 1000)}초를 넘겨 중단되었습니다.`)));
    }, timeoutMs);

    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    // 줄 단위로 끊어 넘긴다. 청크 경계가 줄 가운데를 지나갈 수 있다.
    //
    // 빈 줄도 파서에 넘긴다. 평문을 흘리는 프로바이더(ollama)에게는 빈 줄이 문단
    // 경계라서 여기서 버리면 제목과 본문이 붙어 버린다. JSON 프로바이더는 빈 줄을
    // 파싱하지 못해 null 을 돌려주므로 영향이 없다.
    child.stdout?.on("data", (chunk: string) => {
      pending += chunk;
      let at = pending.indexOf("\n");
      while (at !== -1) {
        const line = pending.slice(0, at).replace(/\r$/, "");
        pending = pending.slice(at + 1);
        const text = consume(line, state);
        if (text !== null) {
          body += text;
          grew();
        }
        at = pending.indexOf("\n");
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          error.code === "ENOENT"
            ? new Error(`CLI 를 실행하지 못했습니다: ${command}`)
            : error,
        ),
      );
    });

    child.on("close", (code) => {
      // 마지막 줄에 개행이 없을 수 있다.
      if (pending.trim() !== "") {
        const text = consume(pending.replace(/\r$/, ""), state);
        if (text !== null) {
          body += text;
          grew();
        }
      }
      finish(() => resolve({ code, body, stderr, state, firstCharMs }));
    });

    child.stdin?.on("error", () => {
      // CLI 가 stdin 을 다 읽기 전에 닫는 경우가 있다. EPIPE 로 죽지 않게 삼킨다.
    });
    child.stdin?.end(stdin);
  });
}

/**
 * 전체를 ```markdown 펜스로 감싸 오는 경우가 있다.
 *
 * normalizeMarkdown() 이 아니라 여기에 둔다 — 로컬 파서 출력에는 이런 일이 없고,
 * 공통 정규화에 넣으면 본문에 정당하게 들어 있는 코드 블록까지 건드릴 위험이 있다.
 * (5단계에서 joinWrappedLines 를 PDF 전용으로 떼어낸 것과 같은 이유다.)
 */
export function stripOuterFence(markdown: string): string {
  const text = markdown.trim();
  const open = /^```[\w-]*\n/.exec(text);
  if (!open) return markdown;
  if (!text.endsWith("```")) return markdown;

  const inner = text.slice(open[0].length, -3);
  // 안쪽에 또 닫는 펜스가 있으면 전체를 감싼 것이 아니라 코드 블록이 여럿인 것이다.
  return /^```/m.test(inner) ? markdown : inner;
}

export interface LlmRequest extends ParseRequest {
  readonly language?: OutputLanguage;
}

/**
 * 모드 B 의 1단계(로컬 파싱)를 돌려주는 함수.
 *
 * 여기서 convert() 를 직접 부르지 않는 이유는 convert.ts 가 이 파일을 부르기
 * 때문이다. 호출자가 넘기게 해 의존 방향을 한쪽으로 유지한다.
 */
export type LocalStage = (request: ParseRequest) => Promise<ParseResult>;

export async function parseWithLlm(request: LlmRequest, localStage: LocalStage): Promise<ParseResult> {
  const started = Date.now();
  const providerId: ProviderId = request.options?.provider ?? "claude";
  const provider = providerOf(providerId);
  const mode: InputMode = request.options?.inputMode ?? "B";
  const model = request.options?.model;

  const log: LogEntry[] = [
    { label: "엔진", value: `LLM · ${provider.label}` },
    { label: "입력 모드", value: mode === "A" ? "A — CLI 가 파일을 직접 읽음" : "B — 로컬 파싱 후 재가공" },
    { label: "모델", value: model ?? "(CLI 기본값)" },
  ];

  const fail = (code: string, message: string, actions: readonly RetryAction[]): ParseResult => ({
    ok: false,
    markdown: "",
    warnings: [],
    log,
    meta: { engine: `LLM · ${provider.label}`, elapsedMs: Date.now() - started },
    error: { code, message, actions },
  });

  // ollama 는 파일 읽기 도구가 없어 모드 A 를 할 수 없다. UI 가 막지만 한 번 더 거른다.
  if (mode === "A" && !provider.supportsModeA) {
    return fail(
      "LLM_MODE_A_UNSUPPORTED",
      `${provider.label} 는 파일을 직접 읽지 못합니다. 모드 B(로컬 파싱 → 재가공)로 변환하세요.`,
      ["retry-mode-b"],
    );
  }
  if (providerId === "ollama" && !model) {
    return fail("LLM_MODEL_REQUIRED", "Ollama 는 모델 이름이 필요합니다. 인스펙터에서 지정하세요.", ["retry-plain"]);
  }

  const { command, report } = await resolveCli(providerId);
  log.push({ label: "CLI 탐색", value: report.join(" / ") });
  if (command === null) {
    return fail("LLM_CLI_NOT_FOUND", `${providerId} CLI 를 찾지 못했습니다.\n\n${report.join("\n")}`, [
      "retry-plain",
    ]);
  }

  // 모드 A 는 변환 1건 전용 임시 디렉터리에 대상 파일 하나만 두고 그곳을 작업
  // 디렉터리로 준다. LLM 이 볼 수 있는 것은 그 하나뿐이고 원본 경로도 나가지 않는다.
  let sandbox: string | null = null;
  let stdin: string;
  const fileName = basename(request.filePath);

  try {
    if (mode === "A") {
      sandbox = await mkdtemp(join(tmpdir(), "markextract-llm-"));
      await copyFile(request.filePath, join(sandbox, fileName));
      stdin = buildPrompt("A", request.language ?? "keep", fileName);
      log.push({ label: "격리", value: `임시 폴더에 ${fileName} 만 복사` });
    } else {
      // 모드 B 는 로컬 파서를 먼저 돌린다. 이미 있는 경로를 그대로 쓴다.
      const local = await localStage({ ...request, options: { ...request.options, engine: "local" } });
      if (!local.ok) {
        return fail(
          "LLM_LOCAL_STAGE_FAILED",
          `로컬 파싱 단계가 먼저 실패했습니다: ${local.error?.message ?? "사유 없음"}`,
          ["retry-plain"],
        );
      }
      log.push({ label: "1단계", value: `로컬 파서 (${local.meta.engine}), ${local.markdown.length}자` });
      stdin = `${buildPrompt("B", request.language ?? "keep", fileName)}\n${local.markdown}\n--- 입력 끝 ---\n`;
    }

    const args = provider.args({ mode, ...(model === undefined ? {} : { model }) });
    log.push({ label: "인자", value: `${command} ${args.join(" ")}` });

    // 아무것도 오지 않는 동안에도 화면이 경과 시간을 셀 수 있게 0 을 한 번 올린다.
    request.onProgress?.(0, 0);
    let silentWarned = false;
    const startedSpawn = Date.now();

    const extras: Parameters<typeof spawnCli>[5] = {
      onChars: (chars) => {
        request.onProgress?.(chars, 0);
      },
    };
    if (request.signal) (extras as { signal?: AbortSignal }).signal = request.signal;
    if (request.options?.timeoutMs !== undefined) {
      (extras as { timeoutMs?: number }).timeoutMs = request.options.timeoutMs;
    }

    // 2분 넘게 한 글자도 오지 않으면 로그에 남긴다. 멈춘 것인지 모델을 올리는
    // 중인지 사용자가 가늠할 단서가 된다.
    const silentTimer = setInterval(() => {
      if (silentWarned) return;
      silentWarned = true;
      log.push({
        label: "대기",
        value: `${Math.round((Date.now() - startedSpawn) / 1000)}초 동안 첫 글자를 받지 못했습니다 — 모델을 올리는 중이거나 응답이 없습니다.`,
      });
    }, SILENT_WARN_MS);

    let outcome;
    try {
      outcome = await spawnCli(command, args, stdin, sandbox ?? undefined, provider.consume, extras);
    } finally {
      clearInterval(silentTimer);
    }
    const elapsedMs = Date.now() - started;
    const markdown = normalizeMarkdown(stripOuterFence(outcome.body));

    // 모드 A 에서 프로바이더가 형식을 못 읽었다. 자동으로 모드 B 로 넘어가지
    // 않는다 (결정 17) — 사용자가 고르게 한다. 조용히 모드를 바꾸면 왜 결과가
    // 달라졌는지 알 수 없다.
    if (markdown.includes(CANNOT_READ)) {
      return {
        ok: false,
        markdown: "",
        warnings: [],
        log: [...log, { label: "결과", value: "형식을 읽지 못했다고 응답" }],
        meta: { engine: `LLM · ${provider.label}`, elapsedMs },
        error: {
          code: "LLM_FORMAT_UNSUPPORTED",
          message:
            `${provider.label} 가 이 파일 형식을 읽지 못했습니다. ` +
            "모드 B(로컬 파싱 → 재가공)로 다시 시도하면 변환할 수 있습니다.",
          actions: ["retry-mode-b", "retry-plain"],
        },
      };
    }

    if (outcome.code !== 0 || markdown.trim() === "") {
      return {
        ok: false,
        markdown: "",
        warnings: [],
        log: [...log, { label: "종료 코드", value: String(outcome.code) }],
        meta: { engine: `LLM · ${provider.label}`, elapsedMs },
        error: diagnose({
          provider: providerId,
          command: `${command} ${args.join(" ")}`,
          exitCode: outcome.code,
          stderr: outcome.stderr,
          unparsed: outcome.state.unparsed,
          empty: markdown.trim() === "",
        }),
      };
    }

    return {
      ok: true,
      markdown,
      // LLM 은 같은 문서라도 결과가 달라진다. 결과물에 그 사실을 남긴다.
      warnings: [
        {
          code: "LLM_NONDETERMINISTIC",
          message: "LLM 엔진의 결과는 재현되지 않습니다. 같은 문서를 다시 변환하면 달라질 수 있습니다.",
        },
      ],
      log: [
        ...log,
        {
          label: "첫 응답",
          value: outcome.firstCharMs === null ? "없음" : `${(outcome.firstCharMs / 1000).toFixed(1)}초`,
        },
        { label: "소요", value: `${(elapsedMs / 1000).toFixed(1)}초` },
      ],
      meta: { engine: `LLM · ${provider.label}`, elapsedMs },
    };
  } catch (error) {
    return {
      ok: false,
      markdown: "",
      warnings: [],
      log: [...log, { label: "오류", value: error instanceof Error ? error.message : String(error) }],
      meta: { engine: `LLM · ${provider.label}`, elapsedMs: Date.now() - started },
      error: {
        code: "LLM_RUN_FAILED",
        message: error instanceof Error ? error.message : String(error),
        actions: ["retry-plain"],
      },
    };
  } finally {
    // 성공·실패·취소 어느 경로로 끝나든 지운다.
    if (sandbox !== null) await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
}
