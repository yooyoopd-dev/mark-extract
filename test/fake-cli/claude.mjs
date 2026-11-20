#!/usr/bin/env node
/**
 * Claude Code CLI 의 stream-json 출력을 흉내 낸다.
 *
 * 핵심은 두 이벤트가 섞여 온다는 것이다 — stream_event 는 진짜 증분이고
 * assistant 는 진행 중인 메시지 전체를 매번 다시 보낸다.
 */
import { BODY, handleCommon, mode, probeBody, readStdin } from "./common.mjs";

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

const delta = (text) =>
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });

const assistant = (whole) =>
  out({ type: "assistant", message: { content: [{ type: "text", text: whole }] } });

if (!handleCommon()) {
  const args = process.argv.slice(2);
  await readStdin();

  if (mode === "empty") {
    out({ type: "result", subtype: "success" });
    process.exit(0);
  }
  if (mode === "stdout-error") {
    out({ type: "result", subtype: "error", error: "model overloaded, try again" });
    process.exit(1);
  }

  const body = mode === "cannot-read" ? "MARKEXTRACT_CANNOT_READ" : mode === "probe" ? probeBody(args) : mode === "fenced" ? "```markdown\n" + BODY + "```" : BODY;
  // 한 글자씩 쪼갠 증분과, 그때까지의 전체를 싣는 assistant 를 함께 흘린다.
  const pieces = body.match(/[\s\S]{1,7}/g) ?? [];
  let whole = "";
  let sent = "";

  for (const piece of pieces) {
    whole += piece;
    if (mode === "noisy") {
      out({ type: "system", subtype: "hook_started", stdout: "훅이 뱉은 잡음 ".repeat(20) });
    }
    if (mode !== "whole-only") delta(piece);

    if (mode === "lagging") {
      // 증분은 앞서 가는데 assistant 는 한 조각 뒤처져 온다. 실제로 관찰되는
      // 순서이고, 접두사 비교만으로는 "어긋났다"고 오판해 통째로 다시 내보내게
      // 되는 자리다. sawDelta 가 여기서 일한다.
      if (sent !== "") assistant(sent);
      sent = whole;
    } else if (mode !== "delta-only") {
      assistant(whole);
    }
  }

  out({ type: "result", subtype: "success" });
}
