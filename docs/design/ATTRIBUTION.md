# 차용 출처와 라이선스

| 프로젝트 | 라이선스 | 차용 범위 | 배포 형태 |
|---|---|---|---|
| [opendataloader-pdf](https://github.com/opendataloader-project/opendataloader-pdf) | Apache-2.0 | PDF 파싱 전체 | JAR 원본 동봉 |
| [kordoc](https://github.com/chrisryugj/kordoc) | MIT | DOCX / XLSX / XLS 파싱 | npm 의존성 |
| [markitdown](https://github.com/microsoft/markitdown) | MIT (Microsoft Corporation) | PPTX 변환 **규칙** | 로직 포팅 (Python → TypeScript 재작성) |
| [llm-co-wiki](https://github.com/yooyoopd-dev/llm-co-wiki) | **GPLv3** | CLI 인자 조합·프로토콜 사실·운영 사실 | 사실 정보만 인용 (코드 복사 없음) |
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

## llm-co-wiki 차용 기준 (결정 14)

### 사실

`llm-co-wiki/LICENSE` 1~4행:

```
LLM Wiki — Copyright (C) 2024-2026 Yong Su

                    GNU GENERAL PUBLIC LICENSE
                       Version 3, 29 June 2007
```

**GPLv3다. AGPL이 아니다** — AGPL §13의 네트워크 사용 조항이 없으므로, 데스크톱 앱에서는 배포(conveying) 시점만 문제가 된다.

전체 커밋 이력(912 커밋) 확인 결과 **기여자가 20명 이상**이다.

```
 731  nash_su <nash.yong@gmail.com>      ← 최초 커밋(2026-04-05) 작성자
  28  yooyoopd-dev <yooyoopd@proton.me>  ← 저장소 소유자
  28  Claude <noreply@anthropic.com>
  22  skfan135 / 20 Dongmin, Yu / 9 Andrew Chen / 6 thinkinbig / … 그 외 다수
```

**`yooyoopd-dev/mark-extract`는 public 저장소다** (GitHub API `visibility: "public"`, `private: false`).

### 판단

두 가지를 차례로 검토했고 둘 다 성립하지 않았다.

**(1) 저작권자 단독 재라이선스** — 재라이선스에는 모든 저작권자의 동의가 필요하다. 위 기여자들의 기여분을 저장소 소유자가 단독으로 재라이선스할 수 없다.

**(2) 사내 전용이므로 배포가 아니라는 논리** — GPLv3 의무는 conveying에서 발동하므로, 하나의 법인 안에서만 쓰고 밖으로 내보내지 않으면 소스 공개 의무가 없다. 이 논리 자체는 타당하다. 그러나 **Mark Extract 저장소가 public이다.** public 저장소에 GPLv3 파생 코드를 올리는 것은 전 세계에 conveying하는 것이고, 그 순간 Mark Extract 전체가 GPLv3가 된다. 이 방식은 저장소를 private으로 돌렸을 때만 성립하는데, 저장소는 public으로 유지하기로 했다.

### 확정

**llm-co-wiki의 코드를 복사하지 않는다.** 설계 문서와 구현은 사실 정보만 인용한다. 이 기준은 구현 단계에서도 유지되어야 한다.

**인용해도 되는 것 — 사실이라 저작권 대상이 아님**

- CLI 인자 조합: `claude -p --output-format stream-json --verbose --model <m>` 등
  - 인용한 것은 "어떤 플래그가 있고 무엇을 한다"는 사실이지 그 조합이 우리 용도에 맞다는 보증이 아니다. 실제로 `--input-format stream-json`은 우리 경로에서 틀렸다 — 실측해 빼냈다 ([03](03-llm-engine.md#프로바이더별-기동))
- 프로토콜 사실: `--verbose`가 켜지면 `stream_event`와 `assistant` 이벤트가 섞여 오고 후자는 증분이 아니라는 점
- 운영 사실: opendataloader CLI에 `--version`이 없어 `--export-options`로 확인해야 한다는 점
- Windows에서 npm 전역 설치가 `.cmd` 셰임을 만든다는 점

**인용하면 안 되는 것 — 표현이라 저작권 대상**

- `createClaudeCodeStreamParser()` 등 함수 본문
- `buildExitError()`의 오류 메시지 문구
- `cli_resolver.rs` / `opendataloader.rs`의 코드와 주석

**6a단계에서 재작성한 범위** — CLI transport 4종(`src/main/llm/providers/`), 실행 파일 탐색기(`resolve.ts`), 오류 진단(`diagnose.ts`). 모두 새로 썼다. 참고한 것은 위의 사실 목록뿐이고, 함수 구조·이름·문구를 가져오지 않았다.

llm-co-wiki의 macOS 로그인 셸 PATH 탐색(`cli_resolver.rs`)은 **기능 자체를 가져오지 않았다.** 제품이 Windows 전용이라 필요가 없다 — 쓰지 않을 코드를 옮길 이유가 없고, 옮기지 않으면 경계 문제도 생기지 않는다.

> 이 정리는 GPLv3 조문과 FSF의 공개 해석에 근거한 것이며 법률 자문이 아니다. 배포 형태를 바꾸게 되면 법무 검토를 받는 편이 안전하다.

---

## Mark Extract 자체 라이선스 (결정 18)

**오픈소스 라이선스를 부여하지 않는다. 사내 전용이다.**

저장소는 public이라 소스를 볼 수 있지만, `LICENSE` 파일을 두지 않으므로 기본 저작권이 유지된다 — 열람은 가능하되 사용·복제·배포 허가는 부여되지 않는다.

이것이 위 GPLv3 결정과 충돌하지 않는 이유: llm-co-wiki 코드를 쓰지 않으므로 copyleft 의무가 발생하지 않는다. 저장소를 계속 public으로 둘 수 있고, 나중에 어떤 라이선스로든 전환할 길도 열려 있다.

**다만 동봉하는 구성요소의 고지 의무는 그대로다.** opendataloader(Apache-2.0)의 LICENSE·NOTICE, kordoc·markitdown(MIT)의 저작권 고지는 배포물에 포함해야 한다. 자체 라이선스를 부여하지 않는 것과 타인 저작물의 고지 의무는 별개다.

## cross-spawn (MIT) — 인용 규칙만

`src/main/llm/launch.ts`의 `quote()`는 [cross-spawn](https://github.com/moxystudio/node-cross-spawn)의 이스케이프 규칙을 따른다 — 따옴표 앞 역슬래시를 두 배로 늘리고, 전체를 따옴표로 감싼 뒤, cmd.exe 메타문자(`< > " ^ | & ? *`)에 `^`를 씌우는 두 겹 구조.

**의존성으로 들이지 않고 20줄을 직접 썼다.** 패키징(asar 제외 목록)을 건드리지 않고, 플랫폼을 인자로 받는 순수 함수라 리눅스 CI에서도 단언할 수 있기 때문이다. 규칙 자체는 Windows `CommandLineToArgvW`와 cmd.exe 파서가 정하는 것이라 구현이 수렴한다.

## 디자인 export

사용자가 제공한 `index.html`은 원본 그대로 [`design/`](../../design/)에 보관한다. 구현은 이 파일을 시각적 계약으로 삼는다.

`index.html`이 참고한 Tolaria는 별개의 상용 앱이다. 레이아웃 아이디어를 참고했을 뿐 그 앱의 자산(로고·상표·코드)은 쓰지 않는다. 원본 압축 파일의 `ref-tolaria.png`는 그 앱의 스크린샷이므로 저장소에 넣지 않았다.
