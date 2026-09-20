/**
 * PDF → Markdown (docs/design/02-parser-adapters.md).
 *
 * opendataloader-pdf 는 Java CLI 라 링크할 수 없고 프로세스로 띄운다. npm 패키지의
 * 래퍼(@opendataloader/pdf)는 PATH 의 `java` 를 찾는데, 우리는 동봉한 JRE 를 써야
 * 하므로 래퍼를 거치지 않고 JAR 을 직접 실행한다.
 *
 * 결과는 stdout 이 아니라 파일로 받는다. --to-stdout 플래그가 있지만 Windows 콘솔
 * 코드페이지의 영향을 받을 여지가 있고, --image-output external 로 뽑은 이미지도
 * 어차피 디렉터리 단위로 회수해야 한다.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import { cleanHtmlInMarkdown } from "../html-in-markdown";
import { joinWrappedLines, normalizeMarkdown } from "../normalize";
import type { DocOptions, LogEntry, ParseRequest, ParseResult, Warning } from "../../shared/parse";

const ENGINE = "로컬 · opendataloader";
/**
 * 10분이었는데 OCR 을 켠 스캔 문서가 그 안에 끝나지 않아 **정상 동작이 실패로
 * 끊겼다**(build.28 실측). 30분으로 올렸고, 설정(`localTimeoutMin`)에서 더 늘릴 수
 * 있다. 이 상수는 설정이 오기 전의 마지막 그물이다.
 */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * OCR 의 최소 보장선. 스캔 수십 장을 이미지에서 인식하면 짧은 제한이 정상 동작을
 * 실패로 만든다 — build.8 에서 LLM 경로가 같은 이유로 물렸다. 설정값이 이보다
 * 크면 설정값을 쓴다.
 */
const OCR_MIN_TIMEOUT_MS = 30 * 60 * 1000;

/** 이 CLI 에는 --version 이 없다. 이걸로 확인하면 정상 설치를 고장으로 오판한다. */
const PROBE_FLAG = "--export-options";

interface JavaTarget {
  readonly command: string;
  /** 동봉 JRE 를 썼는지. 로그에 남겨 Java 미설치 환경 문제를 가려낸다. */
  readonly bundled: boolean;
}

function resourcesRoot(): string {
  // 패키징된 앱에서는 process.resourcesPath, 개발 중에는 저장소 루트의 resources/.
  return app?.isPackaged ? process.resourcesPath : join(__dirname, "../../../resources");
}

/** 동봉 JRE 를 먼저 쓰고, 없으면 PATH 의 java 로 물러난다(개발 편의). */
export function resolveJava(): JavaTarget {
  const exe = process.platform === "win32" ? "java.exe" : "java";
  const bundled = join(resourcesRoot(), "jre", "bin", exe);
  return existsSync(bundled) ? { command: bundled, bundled: true } : { command: "java", bundled: false };
}

export function resolveJar(): string {
  return join(resourcesRoot(), "lib", "opendataloader-pdf-cli.jar");
}

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runJava(args: readonly string[], signal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RunResult> {
  const java = resolveJava();

  return new Promise((resolve, reject) => {
    const child = spawn(
      java.command,
      [
        "-Djava.awt.headless=true",
        // Windows 기본 코드페이지(949)를 타지 않게 한다.
        "-Dfile.encoding=UTF-8",
        "-jar",
        resolveJar(),
        ...args,
      ],
      // 셸을 거치지 않는다 — 경로에 한글·공백이 있어도 안전하다.
      { shell: false },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const kill = () => child.kill("SIGKILL");
    const onAbort = () => {
      kill();
      finish(() => reject(new Error("변환이 취소되었습니다.")));
    };
    const timer = setTimeout(() => {
      kill();
      finish(() => reject(new Error(`변환이 ${Math.round(timeoutMs / 1000)}초를 넘겨 중단되었습니다.`)));
    }, timeoutMs);

    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          error.code === "ENOENT"
            ? new Error(
                java.bundled
                  ? `동봉된 Java 를 실행하지 못했습니다: ${java.command}`
                  : "Java 를 찾지 못했습니다. 동봉 JRE 가 빠진 빌드이거나 PATH 에 java 가 없습니다.",
              )
            : error,
        ),
      );
    });
    child.on("close", (code) => finish(() => resolve({ code, stdout, stderr })));
  });
}

/**
 * CLI 가 살아 있는지 본다. --export-options 는 옵션 목록을 JSON 으로 내놓고 0 으로
 * 끝난다. 문자열을 뒤지는 것보다 JSON 을 파싱해 보는 쪽이 확실하다.
 */
export async function probe(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { code, stdout, stderr } = await runJava([PROBE_FLAG], undefined, 90_000);
    if (code !== 0) return { ok: false, detail: `${PROBE_FLAG} 가 ${code} 로 끝났습니다: ${stderr.trim()}` };

    const parsed: unknown = JSON.parse(stdout);
    const options = (parsed as { options?: unknown }).options;
    if (!Array.isArray(options) || options.length === 0) {
      return { ok: false, detail: "옵션 목록이 비어 있습니다." };
    }
    return { ok: true, detail: `옵션 ${options.length}개 확인` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function buildArgs(
  filePath: string,
  outputDir: string,
  options: DocOptions = {},
  hybridUrl = "",
): string[] {
  const args = [
    filePath,
    "--format", "markdown",
    // 줄 경계를 살려 받는다. 문단 잇기는 normalize.ts 가 CJK 를 봐 가며 한다.
    "--keep-line-breaks",
    // 표를 <table> 로 받는다. 이것 없이 받은 파이프 표는 두 가지가 깨져 있었다
    // (build.8 실측): 병합된 값이 사라지고, 셀 안의 | 가 이스케이프되지 않아
    // 행이 쪼개진다. HTML 로 받으면 구조가 남고, html-in-markdown.ts 가 kordoc
    // 출력과 같은 방식으로 파이프 표로 바꾼다.
    "--markdown-with-html",
    // --quiet 는 쓰지 않는다. 그것이 java.util.logging 을 통째로 끄는 바람에
    // WARNING 도 SEVERE 도 사라졌다 (실측). 서버가 꺼져 있을 때 CLI 가 내주는
    // 친절한 안내까지 삼켜서 실패가 "엔진이 1 로 끝났습니다"만 남았고,
    // collectWarnings() 는 처음부터 한 줄도 받지 못하는 죽은 코드였다.
    // INFO 는 우리가 걸러 낸다 (javaLog).
    "--output-dir", outputDir,
  ];

  // --space-ratio 는 노출하지 않는다. 올리면 한글 문제는 그대로인 채 정당한
  // 공백까지 사라진다 (normalize.ts 주석 참조).
  if (options.tableMethod) args.push("--table-method", options.tableMethod);
  if (options.readingOrder) args.push("--reading-order", options.readingOrder);
  if (options.includeHeaderFooter) args.push("--include-header-footer");
  if (options.imageOutput) args.push("--image-output", options.imageOutput);
  if (options.pages) args.push("--pages", options.pages);
  if (options.password) args.push("--password", options.password);

  // 태그드 PDF 에서는 이것이 hybrid 보다 우선한다. 둘 다 켜면 CLI 가 구조 트리를
  // 쓰고 서버를 부르지 않는다 — 인스펙터가 그 사실을 미리 알린다.
  if (options.useStructTree) args.push("--use-struct-tree");

  // 서버 주소가 없으면 OCR 인자를 붙이지 않는다. 붙이면 CLI 가 기본 주소로 붙다가
  // 실패하고, 사용자는 OCR 을 켰는데 왜 안 되는지 모른다.
  if (options.ocr && hybridUrl !== "") {
    args.push("--hybrid", "docling-fast", "--hybrid-url", hybridUrl);
    if (options.hybridFullPages) args.push("--hybrid-mode", "full");
    // --hybrid-fallback 은 어떤 경우에도 붙이지 않는다 (결정 6). 서버 오류를 조용히
    // Java 경로로 되돌리면 사용자가 OCR 이 안 걸린 것을 모른 채 결과를 받는다.
  }

  return args;
}

/** 검증 전용. 인자 조립만 따로 보기 위해 내보낸다 (scripts/verify-ocr.mjs). */
export const buildArgsForVerify = buildArgs;

/**
 * java.util.logging 이 stderr 에 내는 것을 레벨별로 모은다.
 *
 * 한 건이 두 줄 이상이다 — 첫 줄은 타임스탬프와 클래스명, 다음 줄이 `LEVEL: 본문`
 * 이고, 본문이 여러 줄로 이어지기도 한다. 서버가 꺼졌을 때 CLI 가 내주는 설치·구동
 * 안내가 그 경우다(실측 6줄). 이어지는 줄을 버리면 안내가 반쪽이 된다.
 *
 * INFO 는 버린다. 페이지 수·제목 같은 것이라 사용자 화면에 둘 이유가 없고 양이 많다.
 */
function javaLog(stderr: string): { warnings: Warning[]; severe: string[] } {
  const warnings: Warning[] = [];
  const severe: string[] = [];
  // "Sep 17, 2026 2:28:11 PM org.opendataloader…" — 새 기록의 시작.
  const HEADER = /^[A-Z][a-z]{2} \d{1,2}, \d{4} /;

  let level: "WARNING" | "SEVERE" | null = null;
  let body: string[] = [];

  const flush = (): void => {
    const text = body.join("\n").trim();
    if (level !== null && text !== "") {
      if (level === "SEVERE") severe.push(text);
      else warnings.push({ code: "ENGINE_WARNING", message: text });
    }
    level = null;
    body = [];
  };

  for (const line of stderr.split("\n")) {
    const start = /^(WARNING|SEVERE):\s*(.*)$/.exec(line);
    if (start) {
      flush();
      level = start[1] as "WARNING" | "SEVERE";
      body = [start[2] ?? ""];
    } else if (HEADER.test(line) || /^(INFO|FINE|CONFIG):/.test(line)) {
      flush();
    } else if (level !== null) {
      body.push(line);
    }
  }
  flush();
  return { warnings, severe };
}

/** 검증 전용. 합성 stderr 로 레벨 가르기를 직접 본다 (scripts/verify-ocr.mjs). */
export const javaLogForVerify = javaLog;

/** 서버가 꺼져 있을 때 CLI 가 내는 문구 (실측). 사유를 특정하는 데 쓴다. */
const HYBRID_DOWN = /Hybrid server is not available/i;

export async function parsePdf(request: ParseRequest): Promise<ParseResult> {
  const started = Date.now();
  const java = resolveJava();

  // 변환 1건마다 새 임시 디렉터리. 원본 옆에는 아무것도 쓰지 않는다.
  const dir = await mkdtemp(join(tmpdir(), "markextract-"));

  const log: LogEntry[] = [
    { label: "엔진", value: ENGINE },
    { label: "Java", value: java.bundled ? `동봉 JRE (${java.command})` : `시스템 java (${java.command})` },
  ];

  try {
    const ocr = request.options?.ocr === true && (request.hybridUrl ?? "") !== "";
    const args = buildArgs(request.filePath, dir, request.options, request.hybridUrl ?? "");

    // 제한 시간을 문구에 박지 않고 실제 쓰는 값을 적는다. 전에는 "30분" 이라고
    // 적어 두었는데 실제로는 문서에 실린 값이 쓰여, 10분에 끊긴 이유를 로그만
    // 보고는 알 수 없었다 (build.28).
    const configured = request.options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutMs = ocr ? Math.max(configured, OCR_MIN_TIMEOUT_MS) : configured;
    if (ocr) {
      log.push({
        label: "OCR",
        value: `hybrid 서버 ${request.hybridUrl} · 제한 시간 ${Math.round(timeoutMs / 60_000)}분`,
      });
    }
    // 암호는 로그에 남기지 않는다.
    log.push({ label: "인자", value: args.map((a) => (a === request.options?.password ? "***" : a)).join(" ") });

    log.push({ label: "제한 시간", value: `${Math.round(timeoutMs / 60_000)}분` });

    const { code, stderr } = await runJava(args, request.signal, timeoutMs);
    const elapsedMs = Date.now() - started;
    const logged = javaLog(stderr);

    if (code !== 0) {
      // SEVERE 가 사유를 말해 준다. 서버가 꺼졌을 때 CLI 가 내는 안내에는 설치·구동
      // 명령까지 들어 있어 그대로 보여 주는 편이 우리가 다시 쓰는 것보다 정확하다.
      const reason = logged.severe.join("\n\n");
      const down = HYBRID_DOWN.test(reason);
      return {
        ok: false,
        markdown: "",
        warnings: logged.warnings,
        log: [...log, { label: "엔진 오류", value: reason || "(stderr 에 아무것도 없습니다)" }],
        meta: { engine: ENGINE, elapsedMs },
        error: {
          code: down ? "HYBRID_UNAVAILABLE" : "ENGINE_FAILED",
          message: down
            ? `hybrid OCR 서버에 연결하지 못했습니다.\n\n${reason}`
            : reason || `변환 엔진이 ${code} 로 끝났습니다.`,
          actions: ["retry-plain"],
        },
      };
    }

    const produced = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".md"));
    const first = produced[0];
    if (first === undefined) {
      return {
        ok: false,
        markdown: "",
        warnings: [],
        log: [...log, { label: "엔진 오류", value: logged.severe.join("\n\n") || "(없음)" }],
        meta: { engine: ENGINE, elapsedMs },
        error: {
          code: "NO_OUTPUT",
          message: "변환 엔진이 결과 파일을 내놓지 않았습니다.",
          actions: ["retry-plain"],
        },
      };
    }

    // 표를 먼저 파이프 표로 바꾼다. 줄 잇기보다 앞서야 한다 — HTML 표는 여러 줄에
    // 걸쳐 있어서 먼저 이으면 태그가 한 줄로 뭉개진다.
    const cleaned = cleanHtmlInMarkdown(await readFile(join(dir, first), "utf8"));
    // --keep-line-breaks 로 받았으므로 문단 잇기는 우리 몫이다.
    const markdown = normalizeMarkdown(joinWrappedLines(cleaned.markdown));

    if (markdown.trim() === "") {
      return {
        ok: false,
        markdown: "",
        warnings: [],
        log: [...log, { label: "소요", value: `${(elapsedMs / 1000).toFixed(1)}초` }],
        meta: { engine: ENGINE, elapsedMs },
        error: {
          code: "EMPTY_OUTPUT",
          message: "추출된 텍스트가 없습니다. 스캔 문서일 수 있습니다.",
          actions: ["retry-with-ocr", "retry-plain"],
        },
      };
    }

    return {
      ok: true,
      markdown,
      warnings: [...logged.warnings, ...cleaned.warnings],
      log: [...log, { label: "소요", value: `${(elapsedMs / 1000).toFixed(1)}초` }],
      meta: { engine: ENGINE, elapsedMs },
    };
  } catch (error) {
    return {
      ok: false,
      markdown: "",
      warnings: [],
      log: [...log, { label: "오류", value: error instanceof Error ? error.message : String(error) }],
      meta: { engine: ENGINE, elapsedMs: Date.now() - started },
      error: {
        code: "RUN_FAILED",
        message: error instanceof Error ? error.message : String(error),
        actions: ["retry-plain"],
      },
    };
  } finally {
    // 성공·실패·취소 어느 경로로 끝나든 지운다.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
