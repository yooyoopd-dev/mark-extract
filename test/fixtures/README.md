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
