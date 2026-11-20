#!/usr/bin/env node
/**
 * Gemini CLI 의 `-o stream-json` 출력을 흉내 낸다 (0.60.0 실측).
 *
 * 한 줄에 이벤트 하나이고, 본문은 role=assistant + delta:true 로 쪼개 온다.
 * 우리가 보낸 stdin 이 role=user 로 되돌아오는 것까지 흉내 낸다 — 그것을 본문으로
 * 세면 문서 앞에 프롬프트가 통째로 붙기 때문이다.
 */
import { BODY, handleCommon, mode, probeBody, readStdin } from "./common.mjs";

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

if (!handleCommon()) {
  const args = process.argv.slice(2);
  const stdin = await readStdin();

  // 진짜 CLI 의 `-o json` 은 **여러 줄로 예쁘게 찍힌 JSON 하나**다. 실행기가 줄
  // 단위로 읽으므로 본문을 한 글자도 꺼내지 못한다. 인자를 되돌리면 여기서 깨진다.
  const pretty = args.join(" ").includes("-o json");
  if (pretty) {
    process.stdout.write(JSON.stringify({ session_id: "fake-session", response: BODY }, null, 2) + "\n");
    process.exit(0);
  }

  out({ type: "init", session_id: "fake-session", model: "fake" });
  out({ type: "message", role: "user", content: stdin });

  if (mode === "empty") {
    out({ type: "result", status: "success" });
    process.exit(0);
  }
  if (mode === "stdout-error") {
    out({ type: "result", status: "error", error: { type: "unknown", message: "quota exceeded" } });
    process.exit(1);
  }

  const body = mode === "cannot-read" ? "MARKEXTRACT_CANNOT_READ" : mode === "probe" ? probeBody(args) : mode === "fenced" ? "```markdown\n" + BODY + "```" : BODY;
  for (const piece of body.match(/[\s\S]{1,9}/g) ?? []) {
    out({ type: "message", role: "assistant", content: piece, delta: true });
  }
  out({ type: "result", status: "success", stats: { total_tokens: 1 } });
}
