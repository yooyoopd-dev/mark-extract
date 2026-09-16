#!/usr/bin/env node
/** Codex CLI 의 줄 단위 JSON 이벤트를 흉내 낸다. */
import { BODY, handleCommon, mode, probeBody, readStdin } from "./common.mjs";

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

if (!handleCommon()) {
  const args = process.argv.slice(2);
  await readStdin();

  if (mode === "empty") process.exit(0);
  if (mode === "stdout-error") {
    out({ type: "error", message: "sandbox denied" });
    process.exit(1);
  }

  const body = mode === "cannot-read" ? "MARKEXTRACT_CANNOT_READ" : mode === "probe" ? probeBody(args) : mode === "fenced" ? "```markdown\n" + BODY + "```" : BODY;
  for (const piece of body.match(/[\s\S]{1,9}/g) ?? []) {
    out({ type: "item.agent_message_delta", delta: piece });
  }
  // 증분 뒤에 완성본이 한 번 더 온다. 그대로 이으면 두 배가 된다.
  out({ type: "item.agent_message", message: body });
}
