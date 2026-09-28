/**
 * OCR(hybrid) 서버를 터미널 창에 띄운다.
 *
 * 설정 화면은 구동 명령을 글로 보여 주고 [복사] 버튼만 주었다. 사용자가 터미널을
 * 열고 붙여 넣어야 서버가 뜬다. 그 한 걸음을 버튼이 대신한다 (build.31 요청).
 *
 * **서버를 앱에 붙이지 않는다.** 자식 프로세스로 들고 있으면 앱을 닫을 때 서버도
 * 죽는다. 서버는 앱보다 오래 살아야 하는 것이라(변환 여러 건, 앱 재시작) 터미널
 * 창에 떼어 놓고, 살아 있는지는 기존 [연결 테스트] 가 HTTP 로 본다. 창을 닫는 것이
 * 서버를 끄는 방법이다.
 *
 * `/k` 를 쓰는 이유가 둘이다. 서버는 계속 돌아야 하고, 명령을 찾지 못했을 때도 창이
 * 남아 그 사실을 보여 줘야 한다 — `pip install` 을 하지 않은 PC 에서 창이 깜빡이고
 * 사라지면 사용자는 무엇이 잘못됐는지 알 수 없다.
 */
import { spawn } from "node:child_process";
import { quote } from "./llm/launch";

/** 서버가 설치되는 실행 파일 이름 (pip 콘솔 스크립트). */
const EXE = "opendataloader-pdf-hybrid";

/** 주소가 없거나 포트를 못 읽을 때. 설정 화면의 안내와 같은 값이다. */
const DEFAULT_PORT = "5002";

/** 인식할 글자. 설정에 없으므로 한국어·영어를 고정으로 쓴다. */
const LANG = "ko,en";

/** 설정의 서버 주소에서 포트만 뽑는다. 화면의 안내와 실제가 어긋나면 안 된다. */
export function serverPort(hybridUrl: string): string {
  try {
    const port = new URL(hybridUrl.trim()).port;
    return port === "" ? DEFAULT_PORT : port;
  } catch {
    return DEFAULT_PORT;
  }
}

/** 구동 명령. 화면이 보여 주는 것과 실제로 띄우는 것이 같은 배열에서 나온다. */
export function serverCommand(hybridUrl: string): readonly string[] {
  // --force-ocr 는 텍스트 레이어가 있어도 인식하게 한다. 스캔 판정이 놓친 페이지를
  // 위해 넣는다 (02 문서의 hybrid 절).
  return [EXE, "--port", serverPort(hybridUrl), "--force-ocr", "--ocr-lang", LANG];
}

/** 화면에 글로 띄울 한 줄. */
export const serverCommandLine = (hybridUrl: string): string =>
  serverCommand(hybridUrl)
    .map((arg) => (arg === LANG ? `"${arg}"` : arg))
    .join(" ");

/**
 * cmd 가 토큰을 가르는 글자. 이것이 없는 인자는 감싸지 않는다.
 *
 * 전부 감싸면 `cmd /k` 에 넘길 줄이 따옴표로 시작하고, 그때 cmd 가 바깥 따옴표
 * 한 겹을 벗기는지 마는지가 `/s` 유무와 첫 토큰에 따라 갈린다. 감쌀 필요가 있는
 * 것만 감싸면 그 분기를 피한다 — 여기서는 `ko,en` 하나뿐이다.
 */
const NEEDS_QUOTE = /[\s,;=&|<>^"()!]/;

/** `start` 까지 두 번 파싱되므로 바깥 cmd 용 `^` 이 필요하다 (llm/launch.ts 의 quote). */
const part = (arg: string): string => (NEEDS_QUOTE.test(arg) ? quote(arg) : arg);

export interface StartResult {
  readonly ok: boolean;
  /** 화면에 그대로 띄운다. 성공이면 띄운 명령, 실패면 사유. */
  readonly detail: string;
}

/**
 * 새 콘솔 창을 띄우고 그 안에서 서버를 돌린다.
 *
 * GUI 앱에는 콘솔이 없어 그냥 spawn 하면 창이 생기지 않는다. `start` 를 거쳐야
 * 새 창이 뜬다. 인용은 `llm/launch.ts` 의 규칙을 쓴다 — 그쪽에 cmd 파서와
 * CommandLineToArgvW 두 겹의 근거가 적혀 있다.
 */
export function startServer(hybridUrl: string, platform: NodeJS.Platform = process.platform): StartResult {
  const line = serverCommand(hybridUrl).map(part).join(" ");

  if (platform !== "win32") {
    return { ok: false, detail: `Windows 에서만 띄울 수 있습니다. 터미널에서 직접 돌리세요: ${serverCommandLine(hybridUrl)}` };
  }

  try {
    const child = spawn(
      process.env["ComSpec"] ?? "cmd.exe",
      // start 의 첫 인자는 창 제목이다. 비워 두면 다음 인자를 제목으로 먹는다.
      ["/d", "/s", "/c", "start", '"Mark Extract - OCR 서버"', "cmd", "/k", line],
      { detached: true, windowsVerbatimArguments: true, stdio: "ignore" },
    );
    // 앱이 이 프로세스를 기다리지 않는다. 서버는 앱보다 오래 산다.
    child.unref();
    return { ok: true, detail: serverCommandLine(hybridUrl) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
