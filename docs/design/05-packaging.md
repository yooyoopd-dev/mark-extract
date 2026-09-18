# 05 — 패키징

## 목표

**Windows에서 .exe 파일 하나.** 설치 과정 없이, Java나 Node가 깔려 있지 않은 PC에서도 실행된다.

## 빌드

electron-builder `portable` 타깃. 자기 압축 해제 실행 파일 하나가 나온다.

```
win:
  target: [{ target: portable, arch: [x64] }]
  artifactName: MarkExtract-${version}.exe
portable:
  splashImage: build/splash.bmp
```

JRE 와 JAR 은 **asar 바깥**에 둔다. 자바는 asar 가상 파일 시스템 안의 파일을 실행하거나 읽지 못한다. `asarUnpack` 이 아니라 `extraResources` 를 쓴다 — 이 파일들은 앱 소스 트리 밖(`resources/`)에서 만들어지기 때문이다. 앱의 `resources/` 아래 `jre/`, `lib/` 로 들어가고, 어댑터는 패키징 시 `process.resourcesPath` 를 기준으로 찾는다.

`--self-test` 를 인자 없이 돌릴 수 있게 한글 시험 자료(135KB)도 함께 넣는다.

## JRE 동봉

`@opendataloader/pdf`의 JAR manifest는 `Java-Version: 11`, `Build-Jdk-Spec: 21`이다. Java 11 이상이면 동작한다.

JDK 21에서 `jlink`로 필요한 모듈만 추려 런타임을 만든다.

```
jlink --add-modules <필요 모듈>
      --strip-debug --no-header-files --no-man-pages --compress=zip-6
      --output resources/jre
```

**모듈 — 2단계 실측 확정.** `jdeps --multi-release 21 --print-module-deps --ignore-missing-deps` 결과에 안전용 둘을 더했다.

```
java.base  java.compiler  java.desktop  java.management  java.sql
jdk.unsupported   sun.misc.Unsafe 를 쓰는 라이브러리
jdk.crypto.ec     암호가 걸린 PDF
```

`--ignore-missing-deps` 결과는 하한선이라 런타임에 더 필요할 수 있어 뒤의 둘을 얹었다. 목록은 `scripts/jre.mjs` 에 상수로 박았다 — 매 빌드마다 `jdeps` 를 돌리면 환경에 따라 결과가 흔들린다. 헤드리스로 돌리므로 실행 시 `-Djava.awt.headless=true` 를 준다.

빌드 재현성을 위해 JDK 버전을 고정하고, `jlink` 스크립트를 저장소에 둔다. 빌드 머신마다 JRE 내용이 달라지면 안 된다.

## 용량

JRE 와 JAR 은 2단계에서 실측했다. exe 압축 크기는 아직 추정치다.

| 구성 | 크기 |
|---|---|
| Electron 런타임 | 약 180MB |
| jlink JRE | **54MB (실측)** — 추정 45MB 였음 |
| opendataloader JAR | 23.1MB (실측) |
| kordoc + 앱 코드 | 약 20MB |
| **합계 (압축 전)** | **약 280MB** |
| **portable .exe (압축 후)** | 약 110~130MB (미실측 — 8단계) |

줄이고 싶다면 순서대로 검토한다: `jdeps`로 JRE 모듈 더 줄이기 → `--omit=optional`로 이미 빠진 kordoc 네이티브 확인 → Electron 로케일 파일 정리. Electron 자체를 걷어내는(Tauri 등) 선택은 두 파서가 모두 Node 라이브러리라 사이드카 계층을 새로 만들어야 하므로 비용이 크다.

## 첫 실행

"첫 실행 지연"은 한 덩어리가 아니다. 구간마다 우리가 할 수 있는 일이 다르다.

| 구간 | 무엇이 걸리나 | 무엇으로 덮나 |
|---|---|---|
| 1 | 단일 exe 가 `%TEMP%` 로 약 280MB 를 푼다 + 사내 백신 전수 검사 | `portable.splashImage` (NSIS 스텁) |
| 2 | Electron 부팅 → `whenReady` → 큐·감시 폴더 복원 → `ready-to-show` | 스플래시 **창** (`src/renderer/splash.html`) |
| 3 | 첫 변환의 JVM 콜드 스타트 | 상태 칩·진행률 바 (build.8 에서 넣음) |

**구간 1 에서는 우리 JS 가 한 줄도 돌지 않는다.** BrowserWindow 로는 덮을 수 없고,
NSIS 스텁이 압축을 푸는 동안 띄우는 비트맵이 유일한 수단이다. `build/splash.bmp`
(460×260, 24비트)가 그것이고, 구간 2 의 창과 크기·문구·색을 맞춰 두 구간이 이어져
보이게 했다.

> `build/splash.bmp` 는 Pillow 로 한 번 만들어 커밋했다. 글꼴은 Noto Sans KR
> (400·700), 색은 `tokens.css` 의 `--text-primary`·`--text-secondary`·`--text-muted`·
> `--accent`·`--border-default`. 다시 만들 일이 생기면 같은 값으로 그리면 된다 —
> 개발 컨테이너에 한글 글꼴이 없어 생성 스크립트를 저장소에 두지 않았다.

**구간 2 실측** (리눅스 개발 빌드, 프로세스 시작 기준):

| 상황 | 스플래시 | 본체 |
|---|---|---|
| 빌드 직후 첫 실행 | — | **1,386ms** |
| 그 뒤 | 144~168ms | 185~212ms |

더운 상태에서 버는 것은 40ms 라 보이지 않는다. 스플래시 창이 있는 이유는 첫 줄
하나다 — 사용자의 첫 실행은 언제나 그 1,386ms 쪽 모양이고, 사내 PC 는 백신이 갓
풀린 파일을 한 장씩 검사하므로 더 길다.

**패키징된 Windows 앱의 구간 2 는 재지 못했다.** 창이 뜬 시점을 프로세스 밖에서
알 방법이 없어 CI 가 세지 못한다.

구간 3 은 이미 화면에 나와 있다 — 상태 칩, 진행률 바, 경과 시간과 글자 수.

## 데이터 저장 위치

portable 실행이라도 설정과 변환 이력은 남아야 한다. `%APPDATA%\MarkExtract\`에 둔다.

| 파일 | 내용 |
|---|---|
| `settings.json` | 설정 전체 |
| `queue.json` | 문서 목록과 상태 |
| `output/` | 기본 출력 경로 (설정에서 변경 가능) |

암호는 저장하지 않는다. 변환 1건 동안 메모리에만 둔다.

**이력 보존 (결정 22)**: `queue.json`은 사용자가 지울 때까지 유지하되, 항목이 1,000건을 넘으면 `done` 상태 항목부터 오래된 순으로 정리한다. 정리 대상은 **큐 항목뿐이며**, 사용자가 내보낸 `.md` 파일에는 손대지 않는다. `queued`·`run`·`failed` 항목과 즐겨찾기한 문서는 정리하지 않는다.

## 확정 사항

### 코드 서명 없음 (결정 19)

서명하지 않는다. 결과로 생기는 일:

- 최초 실행 시 SmartScreen이 "알 수 없는 게시자" 경고를 띄운다. 사용자는 **추가 정보 → 실행**을 눌러야 한다
- 사내 백신이 차단할 수 있다. 배포 시 예외 등록이 필요할 수 있다

두 절차를 사용 안내서에 적는다. 나중에 인증서를 확보하면 electron-builder의 서명 설정만 추가하면 되고, 인증서와 비밀번호는 빌드 환경의 비밀값으로 관리하며 저장소에 넣지 않는다.

### 자동 업데이트 없음 (결정 20)

`electron-updater`를 넣지 않는다. 새 버전은 새 exe를 받아 교체한다. "앱 자체는 어떤 네트워크 호출도 하지 않는다"는 전제가 그대로 유지된다. 설정 화면에는 현재 버전만 표시하고 업데이트 확인 버튼을 두지 않는다.

### x64만 (결정 23)

32비트 Windows는 지원하지 않는다. jlink JRE도 x64로만 만든다.
