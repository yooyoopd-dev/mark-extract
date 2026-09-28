#!/usr/bin/env node
/**
 * Codex CLI 의 `exec --json` 줄 단위 이벤트를 흉내 낸다 (0.154.0 실측).
 *
 * thread.started · turn.started 는 인증 없이도 실제로 받아 보았다. 본문이 실리는
 * item.completed 까지는 확인하지 못해, 실행기가 `--output-last-message` 파일을
 * 안전망으로 쓴다 — 여기서도 그 파일을 같이 쓴다.
 */
import { writeFileSync } from "node:fs";
import { BODY, handleCommon, mode, probeBody, readStdin } from "./common.mjs";

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

if (!handleCommon()) {
  const args = process.argv.slice(2);
  await readStdin();

  const at = args.indexOf("--output-last-message");
  const lastMessage = at === -1 ? null : args[at + 1];

  if (mode === "empty") process.exit(0);
  if (mode === "stdout-error") {
    out({ type: "error", message: "sandbox denied" });
    process.exit(1);
  }

  const body = mode === "cannot-read" ? "MARKEXTRACT_CANNOT_READ" : mode === "probe" ? probeBody(args) : mode === "fenced" ? "```markdown\n" + BODY + "```" : BODY;
  if (lastMessage) writeFileSync(lastMessage, body, "utf8");

  out({ type: "thread.started", thread_id: "fake-thread" });
  out({ type: "turn.started" });

  // file-only 는 이벤트 형식이 바뀐 상황을 흉내 낸다. 본문은 파일에만 있다.
  if (mode !== "file-only") {
    // 같은 항목이 updated → completed 로 두 번 온다. 그대로 이으면 두 배가 된다.
    out({ type: "item.updated", item: { id: "i1", type: "agent_message", text: body.slice(0, 5) } });
    out({ type: "item.completed", item: { id: "i1", type: "agent_message", text: body } });
  }
  out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
}
