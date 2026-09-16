#!/usr/bin/env node
/**
 * Ollama 를 흉내 낸다. 다른 셋과 달리 JSON 이 아니라 평문을 흘린다.
 *
 * 진짜 `ollama run` 의 파이프 종료·스트리밍 동작은 이 컨테이너에서 확인하지
 * 못했다 — registry.ollama.ai 가 네트워크 정책에 막혀 모델을 받을 수 없다.
 * 그래서 이 스텁은 설계 문서에 적힌 동작(평문 스트림)을 가정한 것이고,
 * 그 가정 자체는 검증되지 않았다.
 */
import { BODY, handleCommon, mode, probeBody, readStdin } from "./common.mjs";

if (!handleCommon()) {
  const args = process.argv.slice(2);
  await readStdin();

  if (mode === "empty") process.exit(0);
  if (mode === "stdout-error") {
    process.stderr.write("Error: model not found, try pulling it first\n");
    process.exit(1);
  }

  const body = mode === "cannot-read" ? "MARKEXTRACT_CANNOT_READ" : mode === "probe" ? probeBody(args) : mode === "fenced" ? "```markdown\n" + BODY + "```" : BODY;
  for (const line of body.split("\n")) process.stdout.write(line + "\n");
}
