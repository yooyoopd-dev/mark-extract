#!/usr/bin/env node
/** Gemini CLI 의 -o json 출력을 흉내 낸다. 끝에 JSON 하나가 온다. */
import { BODY, handleCommon, mode, probeBody, readStdin } from "./common.mjs";

if (!handleCommon()) {
  const args = process.argv.slice(2);
  await readStdin();

  if (mode === "empty") {
    process.stdout.write(JSON.stringify({ response: "" }) + "\n");
    process.exit(0);
  }
  if (mode === "stdout-error") {
    process.stdout.write(JSON.stringify({ error: { message: "quota exceeded" } }) + "\n");
    process.exit(1);
  }

  const body = mode === "cannot-read" ? "MARKEXTRACT_CANNOT_READ" : mode === "probe" ? probeBody(args) : mode === "fenced" ? "```markdown\n" + BODY + "```" : BODY;
  process.stdout.write(JSON.stringify({ response: body }) + "\n");
}
