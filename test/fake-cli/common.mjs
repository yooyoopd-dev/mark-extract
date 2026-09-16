/** 스텁 공통. 진짜 CLI 의 출력 형식만 흉내 낸다. */
import { readdirSync } from "node:fs";

export const mode = process.env["MARKEXTRACT_FAKE"] ?? "";

export const BODY = "# 제목\n\n한글 본문입니다.\n";

/** stdin 을 끝까지 읽는다. 파이프가 닫히는지 보는 것이기도 하다. */
export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** 모드 A 격리 검증용 — 작업 디렉터리에 무엇이 보이는지와 받은 인자를 그대로 싣는다. */
export function probeBody(args) {
  let entries = [];
  try {
    entries = readdirSync(process.cwd()).sort();
  } catch {
    entries = ["<읽기 실패>"];
  }
  return `CWD=${process.cwd()}\nENTRIES=${entries.join(",")}\nARGS=${args.join(" ")}\n`;
}

/** 본문 말고 다른 동작을 해야 하는 경우를 처리한다. 처리했으면 true. */
export function handleCommon() {
  if (mode === "auth") {
    process.stderr.write("Error: failed to authenticate. Please run `login` first.\n");
    process.exit(1);
  }
  if (mode === "silent") process.exit(1);
  if (mode === "hang") {
    setInterval(() => {}, 1000);
    return true;
  }
  return false;
}
