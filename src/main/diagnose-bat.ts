/**
 * 터미널에서 도는 진단 배치 (`diagnose-ocr.bat`).
 *
 * 설정 화면의 [연결 테스트] 는 `hybrid-http.ts` 의 `fetch(url + "/health")` 하나뿐이다
 * — 200 이 오는지만 본다. 그것으로는 두 가지를 가릴 수 없다.
 *
 *  - 앱의 `fetch` 만 사내 프록시·방화벽에 막히는지 (curl·PowerShell 이 되는데
 *    Electron 이 안 되는 경우가 있다)
 *  - 서버가 살아 있는데도 **변환**이 실패하는지. 본문 변환은 Java CLI 가
 *    `--hybrid-url` 로 직접 부르므로 /health 와 다른 경로다.
 *
 * 그래서 한 창에서 셋을 잇달아 돌린다: /health 두 방식 → `--hybrid` 를 붙인 실제
 * 변환 → 같은 문서를 OCR 없이 로컬 변환. 부팅 직후 첫 변환만 실패하는 build.30
 * 보고도 이 창에서 재현·비교된다.
 *
 * **인자는 앱이 쓰는 것을 그대로 쓴다** (`buildArgs`). 다르면 진단이 아니다.
 * 바꾸는 것은 `--output-dir` 하나뿐이다.
 *
 * 인용 한계: 값은 모두 따옴표로 감싼다. 따옴표 안에서는 `< > & | ^` 가 그대로 가고,
 * `!` 도 지연 확장을 켜지 않았으므로 글자다. `%` 만은 배치가 확장하므로 `%%` 로
 * 늘린다. 경로에 따옴표(`"`)가 있으면 갈라지는데 Windows 파일 이름에는 넣을 수 없다.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import { buildArgs, resolveJar, resolveJava } from "./parsers/pdf-opendataloader";
import { fixturesDir } from "./self-test";
import { settings } from "./settings";

/** 배치 안에서 값으로 쓸 문자열. `%` 만 늘린다 (위 주석의 인용 한계). */
const value = (text: string): string => text.replace(/%/g, "%%");

/** 명령줄 인자 하나. 전부 감싼다 — 어느 것이 공백을 품는지 따지지 않는 쪽이 안전하다. */
const arg = (text: string): string => `"${value(text)}"`;

export interface BatchInput {
  readonly java: string;
  readonly jar: string;
  /** 비어 있으면 /health 절과 OCR 변환 절이 빠진다. 로컬 변환 절은 남는다. */
  readonly hybridUrl: string;
  /** 인자를 주지 않았을 때 쓸 동봉 시험 자료. */
  readonly sample: string;
  /** OCR 을 켠 인자 (`--hybrid` 포함). `--output-dir` 은 배치가 갈아 끼운다. */
  readonly ocrArgs: readonly string[];
  /** 같은 문서를 OCR 없이 돌리는 인자. */
  readonly localArgs: readonly string[];
}

/** 입력 파일과 `--output-dir` 을 배치 변수로 갈아 끼운다. */
function rewrite(args: readonly string[], outDir: string): string {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === "--output-dir") {
      out.push('"--output-dir"', `"%OUTROOT%\\${outDir}"`);
      i += 1;
      continue;
    }
    // 첫 인자가 원본 경로다. 사용자가 끌어다 놓은 파일로 바꾼다.
    out.push(i === 0 ? '"%TARGET%"' : arg(a));
  }
  return out.join(" ");
}

function javaLine(args: string): string {
  return `"%JAVA%" "-Djava.awt.headless=true" "-Dfile.encoding=UTF-8" "-jar" "%JAR%" ${args}`;
}

/** 변환 한 절. 폴더를 비우고 돌리고 종료 코드와 결과 앞부분을 보여 준다. */
function runSection(title: string, dir: string, args: string): string[] {
  return [
    `echo --- ${title} ---`,
    `if exist "%OUTROOT%\\${dir}" rd /s /q "%OUTROOT%\\${dir}"`,
    `mkdir "%OUTROOT%\\${dir}" 2>nul`,
    "echo 명령:",
    `echo   ${javaLine(args)}`,
    "echo 시작 %DATE% %TIME%",
    javaLine(args),
    'set "RC=%ERRORLEVEL%"',
    "echo 끝   %DATE% %TIME%",
    "echo java 종료 코드 = %RC%",
    `for %%f in ("%OUTROOT%\\${dir}\\*.md") do (`,
    "  echo   결과 %%~nxf 앞 20줄:",
    `  powershell -NoProfile -Command "Get-Content -LiteralPath '%%f' -TotalCount 20"`,
    ")",
    `if not exist "%OUTROOT%\\${dir}\\*.md" echo   결과 md 가 없습니다.`,
    "echo.",
  ];
}

export function buildBatch(input: BatchInput): string {
  const hasUrl = input.hybridUrl.trim() !== "";

  const lines: string[] = [
    "@echo off",
    // Windows 기본 코드페이지(949)면 한글이 깨진다.
    "chcp 65001 > nul",
    "title Mark Extract 진단",
    "setlocal",
    "",
    "rem 이 파일은 Mark Extract 설정 화면의 [터미널에서 진단] 이 만듭니다.",
    "rem 자기 문서로 다시 돌리려면 이 파일에 PDF 를 끌어다 놓으세요.",
    'rem   diagnose-ocr.bat "C:\\경로\\내문서.pdf"',
    "",
    'set "TARGET=%~1"',
    `if "%TARGET%"=="" set "TARGET=${value(input.sample)}"`,
    'set "OUTROOT=%TEMP%\\markextract-diag"',
    `set "JAVA=${value(input.java)}"`,
    `set "JAR=${value(input.jar)}"`,
    `set "URL=${value(input.hybridUrl)}"`,
    "",
    "echo ============================================================",
    "echo  Mark Extract 진단",
    "echo ============================================================",
    "echo 대상      : %TARGET%",
    "echo Java      : %JAVA%",
    "echo JAR       : %JAR%",
    hasUrl ? "echo OCR 서버  : %URL%" : "echo OCR 서버  : (주소 없음 — 설정에서 비워 두었습니다)",
    "echo 결과 폴더 : %OUTROOT%",
    "echo.",
    "",
    'if not exist "%TARGET%" (',
    "  echo [!] 대상 파일이 없습니다: %TARGET%",
    "  goto :end",
    ")",
    'if not exist "%JAVA%" (',
    "  echo [!] 동봉 JRE 를 찾지 못했습니다: %JAVA%",
    "  goto :end",
    ")",
    'if not exist "%JAR%" (',
    "  echo [!] 변환 엔진 JAR 을 찾지 못했습니다: %JAR%",
    "  goto :end",
    ")",
    "",
  ];

  if (hasUrl) {
    lines.push(
      "echo --- 1) OCR 서버 /health (curl) ---",
      'curl.exe -sS -i --max-time 10 "%URL%/health"',
      'set "RC=%ERRORLEVEL%"',
      "echo.",
      "echo curl 종료 코드 = %RC%",
      "echo.",
      "echo --- 2) OCR 서버 /health (PowerShell) ---",
      // 앱의 fetch 와 다른 통로로 한 번 더 두드린다. 한쪽만 되면 프록시·방화벽이다.
      `powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 '%URL%/health'; Write-Host $r.StatusCode $r.Content } catch { Write-Host ('실패: ' + $_.Exception.Message) }"`,
      "echo.",
      ...runSection("3) OCR 변환 (--hybrid)", "hybrid", rewrite(input.ocrArgs, "hybrid")),
    );
  } else {
    lines.push("echo --- 1~3) OCR 절을 건너뜁니다 — 설정에 서버 주소가 없습니다. ---", "echo.");
  }

  lines.push(
    ...runSection("4) 로컬 변환 (OCR 없이)", "local", rewrite(input.localArgs, "local")),
    "echo 결과 파일은 %OUTROOT% 에 남겨 두었습니다.",
    "echo.",
    ":end",
    "pause",
    "endlocal",
    "",
  );

  // cmd.exe 는 LF 로만 끝난 배치의 마지막 줄을 흘리는 일이 있다.
  return lines.join("\r\n");
}

/**
 * 배치를 설정 폴더에 쓰고 경로를 돌려준다.
 *
 * 플랫폼 확인은 하지 않는다 — 호출자(ipc)가 한다. 그래야 리눅스 검증에서 파일
 * 내용을 그대로 단언할 수 있다.
 */
export async function writeBatch(): Promise<string> {
  const dir = app.getPath("userData");
  const target = join(dir, "diagnose-ocr.bat");
  const hybridUrl = settings().hybridUrl;

  // 출력 폴더는 배치가 갈아 끼우므로 여기서는 자리만 채운다.
  const text = buildBatch({
    java: resolveJava().command,
    jar: resolveJar(),
    hybridUrl,
    sample: join(fixturesDir(), "sample-ko.pdf"),
    ocrArgs: buildArgs("%TARGET%", "%OUTROOT%", { ocr: true }, hybridUrl),
    localArgs: buildArgs("%TARGET%", "%OUTROOT%", {}, ""),
  });

  await mkdir(dir, { recursive: true });
  await writeFile(target, text, "utf8");
  return target;
}
