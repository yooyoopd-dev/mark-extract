# 가짜 CLI

`scripts/verify-llm.mjs` 가 쓰는 스텁이다. 각 프로바이더의 **출력 프로토콜만**
흉내 낸다 — 모델을 부르지 않으므로 결정적이고 오프라인에서 돈다.

이것으로 검증하는 것은 우리 쪽 코드다: 인자 조합, 줄 파싱, 중복 제거, 모드 A
격리, 오류 진단. 진짜 CLI 가 이 형식대로 말하는지는 이것으로 알 수 없고,
`claude` 는 실제로 돌려 확인했다 (docs/design/03-llm-engine.md).

동작은 `MARKEXTRACT_FAKE` 환경 변수로 고른다.

| 값 | 무엇을 흉내 내나 |
|---|---|
| (없음) | 정상 — 마크다운을 내놓는다 |
| `delta-only` | 증분 이벤트만 (claude) |
| `whole-only` | 전체 반복 이벤트만 — 증분 없는 버전 (claude) |
| `mixed` | 증분과 전체가 섞임 — 중복이 나기 쉬운 경우 (claude) |
| `noisy` | 훅 이벤트를 섞는다 (claude) |
| `fenced` | 전체를 ```markdown 펜스로 감싼다 |
| `empty` | 종료 코드 0 인데 본문이 없다 |
| `auth` | 인증 만료 메시지를 stderr 로 내고 1 로 끝난다 |
| `silent` | 아무것도 없이 1 로 끝난다 |
| `stdout-error` | 진단을 stdout 의 JSON 채널로 흘리고 1 로 끝난다 |
| `hang` | 끝나지 않는다 — 취소 검증용 |
| `cannot-read` | 형식을 읽지 못했다는 표식만 내놓는다 |
| `probe` | 작업 디렉터리 목록과 인자를 본문에 실어 보낸다 — 모드 A 격리 검증용 |
