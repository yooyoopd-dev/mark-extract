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

설계 단계. 구현 코드는 아직 없다.

- **설계 문서** — [`docs/design/`](docs/design/)
- **디자인 원본 (시각적 계약)** — [`design/`](design/)

## 라이선스

**오픈소스 라이선스를 부여하지 않는다. 사내 전용이다.**

저장소는 public이라 소스를 볼 수 있지만 `LICENSE` 파일이 없어 기본 저작권이 유지된다 — 열람은 가능하되 사용·복제·배포 허가는 부여되지 않는다.

동봉하는 구성요소(Apache-2.0, MIT)의 저작권 고지 의무는 그대로 이행한다. 차용 출처와 근거는 [`docs/design/ATTRIBUTION.md`](docs/design/ATTRIBUTION.md)에 있다.
