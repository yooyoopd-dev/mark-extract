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

[로드맵](docs/design/06-roadmap.md) 8단계 중 **1단계(프로젝트 골격 + 디자인 토큰) 완료**. 파서·LLM·UI는 아직 없다.

- **설계 문서** — [`docs/design/`](docs/design/)
- **디자인 원본 (시각적 계약)** — [`design/`](design/)

## 개발

```
npm install
npm run verify   # 토큰 대조 + 빌드 + 스모크 (1단계 검증 전체)
npm start        # 앱 실행
```

| 스크립트 | 내용 |
|---|---|
| `tokens` / `tokens:check` | `design/index.html`에서 색 토큰 생성 / 드리프트 검사 |
| `typecheck` | 타입 검사만 |
| `build` | 토큰 검사 → `tsc` → 렌더러 정적 파일 복사 |
| `smoke` | Electron을 띄워 보안 설정·토큰·preload 확인, 스크린샷 저장 |

`src/renderer/styles/tokens.css`는 **자동 생성 파일이다.** 직접 고치지 말고 `design/index.html`을 고친 뒤 `npm run tokens`를 돌린다. 어긋나면 빌드가 실패한다.

## 라이선스

**오픈소스 라이선스를 부여하지 않는다. 사내 전용이다.**

저장소는 public이라 소스를 볼 수 있지만 `LICENSE` 파일이 없어 기본 저작권이 유지된다 — 열람은 가능하되 사용·복제·배포 허가는 부여되지 않는다.

동봉하는 구성요소(Apache-2.0, MIT)의 저작권 고지 의무는 그대로 이행한다. 차용 출처와 근거는 [`docs/design/ATTRIBUTION.md`](docs/design/ATTRIBUTION.md)에 있다.
