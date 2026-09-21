# 시험 자료

`sample-ko.pdf` 는 PDF 어댑터 검증(`npm run verify:pdf`)에 쓴다. 한글·영문 혼재,
H1~H3 제목 계층, 3×3 표, 목록, 숫자·특수문자를 담았다.

PDF 를 커밋해 둔 이유는 CI 가 플랫폼마다 PDF 생성기를 갖출 수 없기 때문이다.
대신 원본 HTML 과 생성 명령을 함께 둬 재현할 수 있게 했다.

```
chrome --headless --disable-gpu --no-pdf-header-footer \
       --print-to-pdf=sample-ko.pdf file://$PWD/sample-ko.html
```

한글 글꼴(Noto Sans CJK KR 등)이 설치된 환경에서 돌려야 한다. 글꼴이 없으면
글자가 빈 사각형으로 들어가 검증이 무의미해진다.


## sample-table.docx · sample-table.pdf

build.8 Windows 실측에서 드러난 결함을 재현하는 자료다. `sample-ko.*` 의 표는
3×3 단순 표라 두 엔진 모두 파이프 표로 잘 내놓았고, 그래서 단언 52개가 전부
통과하는데도 실제 문서에서는 깨졌다.

여기 담은 것:

| 무엇 | 왜 |
|---|---|
| 가로·세로 병합 셀 | kordoc 이 `tableToMarkdown()` 대신 `tableToHtml()` 로 빠진다 |
| 셀 안 여러 문단 | 셀 내용이 `<br>` 로 이어진다 |
| 셀 안 `\|` `<` `&` | 표 구조를 깨거나 엔티티로 이스케이프된다 |
| **표 밖** 특수문자 | 표 안에만 두면 xmldom 이 파싱하며 풀어 버려 디코드 경로가 검증되지 않는다 |

마지막 줄은 실제로 겪은 것이다. 처음에는 특수문자를 표 안에만 뒀는데, 엔티티
디코드를 통째로 없애도 검증이 통과했다.

PDF 는 `sample-table.html` 을 헤드리스 크로미움으로 찍는다.

```
chrome --headless --disable-gpu --no-pdf-header-footer \
       --print-to-pdf=sample-table.pdf file://$PWD/sample-table.html
```

## kordoc 의 자간 복원 휴리스틱 (알려진 제약)

kordoc 은 표 셀 텍스트에서 **공백을 지우는 규칙**을 갖고 있다
(`sanitizeText`, `chunk-A2JDWBKG.js:332`).

```
30자 이하 + 3토큰 이상 + 한글 1글자 토큰이 70% 이상 + 날짜 단위가 아님
  → 토큰을 공백 없이 붙인다
```

HWP 서식의 `성 명` `이 력 서` 같은 자간 늘림을 되돌리려는 것인데, 평범한 문장도
걸린다. `셀 하나에 세 줄`(4토큰 중 단음절 3개 = 75%)은 `셀하나에세줄`이 된다.

**끄는 옵션이 없다.** 지워진 공백을 복원할 방법도 없다(어디에 있었는지 알 수
없다). 그래서 우리가 손대지 않고, 시험 자료 문구만 이 규칙을 건드리지 않게
골랐다. 실제 한국어 문서에서 짧은 셀이 붙어 나오면 이것이 원인이다.

### 마크다운 기호로 시작하는 줄 (build.25 실측)

`sample-table.docx` · `sample-table.html` 에 이 두 줄을 더했다.

```
* 별표로 시작하는 줄이다. Word 에서 손으로 찍은 기호다.
한 줄 안에 밑줄 _강조_ 와 물결 ~취소~ 와 백틱 `코드` 가 섞여 있다.
```

kordoc 의 `escapeGfm` 이 `*` `_` `~` `` ` `` 를 전부 이스케이프해서 사용자 화면에
`\* ` 가 보였다. 그때까지 **시험 자료 어디에도 그 글자가 없었다** — 단언 52개가 전부
통과하는 동안 보이지 않던 이유가 그것이다. build.8 의 표와 같은 종류의 구멍이다.

두 엔진에 같은 자료가 들어가므로 opendataloader 쪽도 함께 본다(이쪽은 원래
이스케이프하지 않는다).

## sample-image.* (build.30)

build.29 실측에서 "PDF 로컬 추출 결과에 `[이미지 참조]` 가 계속 붙는다" 는 보고가
왔다. 원인은 네 어댑터가 모두 그림을 **파일 참조**로 내놓는데 그 파일이 변환 1건짜리
임시 디렉터리와 함께 지워진다는 것이었다 — 사용자에게 간 것은 어디도 가리키지 않는
링크뿐이다.

그때까지 **시험 자료 어디에도 그림이 한 장도 없었다.** build.8 의 표, build.25 의
별표와 같은 종류의 구멍이다. 그래서 그림 전용 자료를 따로 만든다
(`make-image-sample.py`). 기존 자료는 다시 만들지 않는다 — build.25 에서
`make-office.py` 가 무관한 파일을 덮어쓴 일이 있다.

담은 것:

| 무엇 | 왜 |
|---|---|
| **두 쪽**에 걸친 그림 | 한 쪽이면 쪽 번호가 늘 1 이라 맞는지 틀리는지 구별되지 않는다 |
| 표 셀 안의 그림 | 그 자리에는 인용 줄을 넣을 수 없어 처리 경로가 다르다 |
| 제목 없는 슬라이드의 그림 | 앞 슬라이드의 제목이 넘어오면 거짓 위치가 된다 |

```
python3 test/fixtures/make-image-sample.py
chrome --headless --disable-gpu --no-pdf-header-footer \
       --print-to-pdf=sample-image.pdf file://$PWD/sample-image.html
```

### kordoc 이 표 셀의 그림을 옮긴다 (알려진 제약)

`sample-image.docx` 를 kordoc 에 그대로 넣으면 표 셀의 그림이 **셀에서 빠져 문서
끝으로 간다**(실측).

```
| 구분 | 그림 |
| --- | --- |
| 표 안 |          ← 비었다

## 3. 둘째 그림

![image](image_003.png)
![image](image_002.png)   ← 표 안에 있던 그림
```

우리 후처리 전에 이미 그렇게 온다. 고칠 수 있는 지점이 아니라서 DOCX 쪽에는 표 셀
단언을 걸지 않았다 — 같은 검사를 PDF 자료로 한다(opendataloader 는 셀 안에 그대로
둔다).
