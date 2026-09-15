# 차용 출처와 라이선스

| 프로젝트 | 라이선스 | 차용 범위 | 배포 형태 |
|---|---|---|---|
| [opendataloader-pdf](https://github.com/opendataloader-project/opendataloader-pdf) | Apache-2.0 | PDF 파싱 전체 | JAR 원본 동봉 |
| [kordoc](https://github.com/chrisryugj/kordoc) | MIT | DOCX / XLSX / XLS 파싱 | npm 의존성 |
| [markitdown](https://github.com/microsoft/markitdown) | MIT (Microsoft Corporation) | PPTX 변환 **규칙** | 로직 포팅 (Python → TypeScript 재작성) |
| [llm-co-wiki](https://github.com/yooyoopd-dev/llm-co-wiki) | **GPL** | 아래 참조 — **결정 보류** | 사실 정보만 인용 |
| 디자인 export | 사용자 제공 | UI 전체 | 원본 유지 |

---

## Apache-2.0 — opendataloader-pdf

JAR을 그대로 동봉하므로 Apache-2.0 §4의 의무가 발생한다.

- `LICENSE` 사본 포함
- 원본의 `NOTICE` 파일 포함 — npm 패키지 `@opendataloader/pdf`의 `NOTICE`와 `THIRD_PARTY/` 디렉터리에 들어 있다
- JAR은 수정하지 않으므로 변경 고지는 불필요

배포물의 `resources/lib/` 옆에 `LICENSE`·`NOTICE`·`THIRD_PARTY_LICENSES.md`를 함께 둔다.

## MIT — kordoc, markitdown

저작권 고지와 라이선스 전문을 함께 배포하면 된다.

- **kordoc**: npm 의존성이므로 `license-checker` 류 도구로 전이 의존성까지 수집해 `THIRD_PARTY_LICENSES.md`를 생성한다. kordoc 자신의 `NOTICE`·`THIRD_PARTY`도 포함한다
- **markitdown**: 코드를 복사하지 않고 변환 규칙만 옮긴다. 그래도 파생으로 볼 여지가 있으므로 출처와 MIT 고지를 남기고, 소스 파일 헤더에도 근거를 적는다

## llm-co-wiki — GPL, 결정 보류

### 사실

`llm-co-wiki/LICENSE` 첫 줄:

```
LLM Wiki — Copyright (C) 2024-2026 Yong Su

                    GNU GENERAL PUBLIC LICENSE
```

전체 커밋 이력(912 커밋) 확인 결과 **기여자가 20명 이상**이다.

```
 731  nash_su <nash.yong@gmail.com>      ← 최초 커밋(2026-04-05) 작성자
  28  yooyoopd-dev <yooyoopd@proton.me>  ← 저장소 소유자
  28  Claude <noreply@anthropic.com>
  22  skfan135
  20  Dongmin, Yu
   9  Andrew Chen
   … 그 외 다수
```

### 판단

당초 "저작권자 본인이 Mark Extract에 한해 재라이선스한다"로 결정했으나, **그 전제가 성립하지 않는다.** 재라이선스에는 모든 저작권자의 동의가 필요하고, 위 기여자들의 기여분을 저장소 소유자가 단독으로 재라이선스할 수 없다.

### 현재 기준

결정이 날 때까지 **코드를 복사하지 않는다.** 설계 문서와 구현은 다음만 인용한다.

**인용해도 되는 것 — 사실이라 저작권 대상이 아님**

- CLI 인자 조합: `claude -p --output-format stream-json --input-format stream-json --verbose --model <m>` 등
- 프로토콜 사실: `--verbose`가 켜지면 `stream_event`와 `assistant` 이벤트가 섞여 오고 후자는 증분이 아니라는 점
- 운영 사실: opendataloader CLI에 `--version`이 없어 `--export-options`로 확인해야 한다는 점
- Windows에서 npm 전역 설치가 `.cmd` 셰임을 만든다는 점

**인용하면 안 되는 것 — 표현이라 저작권 대상**

- `createClaudeCodeStreamParser()` 등 함수 본문
- `buildExitError()`의 오류 메시지 문구
- `cli_resolver.rs` / `opendataloader.rs`의 코드와 주석

### 선택지

| | 내용 | 영향 |
|---|---|---|
| (a) | 사실만 차용하고 코드는 독립 구현 | **현재 기준.** 라이선스 리스크 없음. Mark Extract 라이선스를 자유롭게 정할 수 있음 |
| (b) | 모든 기여자에게 재라이선스 동의를 받음 | 현실성 낮음 |
| (c) | Mark Extract도 GPL로 배포 | llm-co-wiki 코드를 제약 없이 사용. 대신 exe를 받는 사람에게 소스 제공 의무 발생 |

이 결정이 Mark Extract 자체 라이선스와 맞물린다. [06-roadmap 미결 사항](06-roadmap.md#미결-사항) 참조.

---

## 디자인 export

사용자가 제공한 `index.html`은 원본 그대로 [`design/`](../../design/)에 보관한다. 구현은 이 파일을 시각적 계약으로 삼는다.

`index.html`이 참고한 Tolaria는 별개의 상용 앱이다. 레이아웃 아이디어를 참고했을 뿐 그 앱의 자산(로고·상표·코드)은 쓰지 않는다. 원본 압축 파일의 `ref-tolaria.png`는 그 앱의 스크린샷이므로 저장소에 넣지 않았다.
