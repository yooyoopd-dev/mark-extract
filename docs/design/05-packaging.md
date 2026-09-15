# 05 — 패키징

## 목표

**Windows에서 .exe 파일 하나.** 설치 과정 없이, Java나 Node가 깔려 있지 않은 PC에서도 실행된다.

## 빌드

electron-builder `portable` 타깃. 자기 압축 해제 실행 파일 하나가 나온다.

```
build:
  win:
    target: [portable]
    artifactName: MarkExtract-${version}.exe
  asarUnpack:
    - resources/jre/**
    - resources/lib/*.jar
```

JRE와 JAR은 **asar에 넣지 않는다.** 자바는 asar 가상 파일 시스템 안의 파일을 실행하거나 읽지 못한다.

## JRE 동봉

`@opendataloader/pdf`의 JAR manifest는 `Java-Version: 11`, `Build-Jdk-Spec: 21`이다. Java 11 이상이면 동작한다.

JDK 21에서 `jlink`로 필요한 모듈만 추려 런타임을 만든다.

```
jlink --add-modules <필요 모듈>
      --strip-debug --no-header-files --no-man-pages --compress=zip-6
      --output resources/jre
```

필요 모듈은 `jdeps`로 JAR을 분석해 결정한다. PDF 처리에 AWT 이미지 경로가 걸리므로 `java.desktop`이 들어갈 가능성이 높다 — **확정 전 실측 필요**. 헤드리스로 돌리므로 실행 시 `-Djava.awt.headless=true`를 준다.

빌드 재현성을 위해 JDK 버전을 고정하고, `jlink` 스크립트를 저장소에 둔다. 빌드 머신마다 JRE 내용이 달라지면 안 된다.

## 용량

**추정치다.** 실제 빌드로 확인하지 않았다.

| 구성 | 크기 |
|---|---|
| Electron 런타임 | 약 180MB |
| jlink JRE | 약 45MB |
| opendataloader JAR | 24.2MB (실측) |
| kordoc + 앱 코드 | 약 20MB |
| **합계 (압축 전)** | **약 270MB** |
| **portable .exe (압축 후)** | **약 110~130MB** |

줄이고 싶다면 순서대로 검토한다: `jdeps`로 JRE 모듈 더 줄이기 → `--omit=optional`로 이미 빠진 kordoc 네이티브 확인 → Electron 로케일 파일 정리. Electron 자체를 걷어내는(Tauri 등) 선택은 두 파서가 모두 Node 라이브러리라 사이드카 계층을 새로 만들어야 하므로 비용이 크다.

## 첫 실행

단일 exe는 실행할 때마다 임시 폴더로 압축을 푼다. 여기에 더해:

- **JVM 콜드 스타트** — 첫 PDF 변환이 이후보다 느리다
- **사내 백신 스캔** — 처음 보는 큰 실행 파일은 전수 검사를 받는다. 수십 초가 걸릴 수 있다

두 경우 모두 앱이 멈춘 것처럼 보이므로, 스플래시와 첫 변환 진행 표시를 명확히 둔다. "처음 실행은 시간이 걸릴 수 있습니다" 안내를 띄운다.

## 데이터 저장 위치

portable 실행이라도 설정과 변환 이력은 남아야 한다. `%APPDATA%\MarkExtract\`에 둔다.

| 파일 | 내용 |
|---|---|
| `settings.json` | 설정 전체 |
| `queue.json` | 문서 목록과 상태 |
| `output/` | 기본 출력 경로 (설정에서 변경 가능) |

암호는 저장하지 않는다. 변환 1건 동안 메모리에만 둔다.

## 미결

- **코드 서명** — 서명하지 않으면 SmartScreen 경고가 뜨고, 사내 배포에서 차단될 수 있다. 인증서 보유 여부 확인 필요
- **자동 업데이트** — 오프라인 전제와 충돌한다. 현재 설계는 자동 업데이트 없음
- 32비트 지원 여부 (현재 x64만 가정)
