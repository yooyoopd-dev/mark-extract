# Mark Extract

문서를 넣으면 **Markdown만** 내놓는 Windows 단일 실행 AI Document Parser.

사내망·오프라인 환경을 우선 전제로 한다. 앱 자체는 네트워크 호출을 하지 않으며, 외부와 통신하는 경로는 사용자가 명시적으로 켠 두 가지(hybrid OCR 서버, LLM CLI)뿐이다.

| 포맷 | 엔진 |
|---|---|
| PDF | [opendataloader-pdf](https://github.com/opendataloader-project/opendataloader-pdf) (JRE·JAR 동봉) |
| DOCX / XLSX / XLS | [kordoc](https://github.com/chrisryugj/kordoc) |
| PPTX | [markitdown](https://github.com/microsoft/markitdown) 변환 규칙 포팅 |

문서마다 **로컬 엔진**과 **LLM 엔진**(claude / gemini / codex / ollama CLI) 중에서 고른다.

## 상태

[로드맵](docs/design/06-roadmap.md) 8단계 중 **2단계까지 완료**. PDF → Markdown 변환이 동작한다. Office·PPTX 어댑터와 LLM 엔진, 본 UI는 아직 없다.

- **설계 문서** — [`docs/design/`](docs/design/)
- **디자인 원본 (시각적 계약)** — [`design/`](design/)

## 개발

```
npm install
npm run resources   # opendataloader JAR 을 resources/lib/ 로
npm run jre         # jlink 로 경량 JRE 생성 (JDK 17+ 필요)
npm run verify      # 토큰 대조 + 빌드 + 셸 스모크 + PDF 변환 검증
npm start           # 앱 실행
```

변환이 되는지 빠르게 보려면:

```
npm start -- --self-test            # 함께 넣어 둔 한글 시험 자료
npm start -- --self-test 내문서.pdf
```

| 스크립트 | 내용 |
|---|---|
| `tokens` / `tokens:check` | `design/index.html`에서 색 토큰 생성 / 드리프트 검사 |
| `typecheck` | 타입 검사만 |
| `build` | 토큰 검사 → `tsc` → 렌더러 정적 파일 복사 |
| `smoke` | Electron을 띄워 보안 설정·토큰·preload·렌더러 모듈 확인, 스크린샷 저장 |
| `resources` / `jre` | JAR 복사 / 경량 JRE 생성 |
| `verify:pdf` | 한글 PDF 변환 단언 15개 |
| `dist:win` | Windows portable exe 빌드 |

`resources/`(JRE·JAR)는 빌드 산출물이라 git 에 없다. `npm run resources && npm run jre` 로 만든다.

Windows 동작 확인은 [GitHub Actions](.github/workflows/build.yml) 의 `debug-windows` job 이 만드는 아티팩트로 한다 — portable exe 와 변환 결과가 올라온다.

`src/renderer/styles/tokens.css`는 **자동 생성 파일이다.** 직접 고치지 말고 `design/index.html`을 고친 뒤 `npm run tokens`를 돌린다. 어긋나면 빌드가 실패한다.

## 라이선스

**오픈소스 라이선스를 부여하지 않는다. 사내 전용이다.**

저장소는 public이라 소스를 볼 수 있지만 `LICENSE` 파일이 없어 기본 저작권이 유지된다 — 열람은 가능하되 사용·복제·배포 허가는 부여되지 않는다.

동봉하는 구성요소(Apache-2.0, MIT)의 저작권 고지 의무는 그대로 이행한다. 차용 출처와 근거는 [`docs/design/ATTRIBUTION.md`](docs/design/ATTRIBUTION.md)에 있다.
