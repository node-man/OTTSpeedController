# 개인 자막의 파일 교환

작품 원본·자막·요청·응답은 `private-subtitles/` 아래 보관한다. 공개 코드와 테스트에는 원본 대사를 넣지 않는다. 설치 패키지는 명시한 실행 파일만 포함한다.

## 원본과 복구

CP949 SMI는 다음 도구로 예외 기반 디코딩과 정확한 바이트 왕복을 확인한 후 UTF-8 스냅샷을 만든다. 기존 출력은 덮어쓰지 않는다.

```powershell
./scripts/decode-smi.ps1 -SourcePath private-subtitles/input.smi -DestinationPath private-subtitles/input.smi.utf8.txt
```

`scripts/subtitle-preparation.mjs`는 작은 준비 스크립트에서 사용하는 함수 모음이다.

- `parseSami`: 언어별 원본 ID·SYNC 시각·평문을 분리한다. 기존 records와 전체 대조해 원본 대응을 확인한다.
- `recoverTrack`: 지정한 비대사 카드만 상태열에서 분리한다. 앞 대사와 지우기 시각을 유지하고 카드 종료는 다음 원본 이벤트에서 가져온다. 전체 시간순 정렬은 하지 않는다.
- 같은 시각의 서로 다른 대사는 명시한 인접 ID만 합쳐 두 본문을 파일 순서로 보존한다. 다음 원본 이벤트까지 함께 표시하는 임시 정책이며 실제 발화 시각을 복원했다는 뜻은 아니다.
- 지정하지 않은 시간 역전·동일시각 충돌·마지막 종료 누락은 거부한다. 모든 비어 있지 않은 원문 이벤트가 출력에 정확히 한 번 대응하는지 확인한다.
- `alignment`: 시간 중첩에 따른 다대다 후보를 기록한다. 의미 일치를 확정하지 않는다.

`core.makeTranslationRequest`의 `outputSlots`는 요청 전에 확정한 원문 근거 구간만 전달하는 선택 항목이다. 기본 UI 동작은 유지한다. 영어 시간축에 A만의 화면 표기나 영어가 없는 구간을 보충하면 원본 ID·시각·근거와 미확인 범위를 따로 기록해야 한다. 이 슬롯도 템플릿과 해시에 포함된다. 응답이 슬롯을 추가하는 기능이 아니다.

## 분할과 반환

전체 요청은 보존한다. `makeChunks`는 문장 끝과 관찰된 공백을 우선해 나누고 겹친 표시 구간을 분리하지 않는다. 실제 장면·문장 경계는 완전 자동 판정하지 않으므로 전체 원문과 읽기 전용 앞뒤 문맥을 제공한다.

각 작업에는 `ownedSlotIds`, `ownedSlots`, `readOnlyContext`, 부분 `outputTemplate`을 넣는다. 각 출력 ID는 정확히 한 작업만 담당한다. 응답의 메타데이터는 전체 요청과 같고 cue에는 `id`, `text`만 넣는다. 검토 이유·용어 결정·화면 확인 필요 사항은 별도 review 파일로 받는다.

완전한 응답 하나를 받은 경우:

```powershell
node scripts/subtitle-response.mjs private-subtitles/episode.translation-request.json private-subtitles/result/episode private-subtitles/episode.translation-response.json
```

부분 결과를 받은 경우 manifest 순서대로 모든 부분 파일을 전달한다:

```powershell
node scripts/subtitle-response.mjs private-subtitles/episode.translation-request.json private-subtitles/result/episode --chunks private-subtitles/episode.chunks.json private-subtitles/episode.part-01.response.json private-subtitles/episode.part-02.response.json
```

도구는 저장 요청의 해시를 원문·참고·슬롯에서 다시 계산하고, 부분별 소유권과 누락·추가·중복·빈 번역을 확인한다. 부분 결과를 합친 후 기존 전체 응답 검증기를 호출한다. A나 자체 번역으로 누락을 채우지 않는다. 출력은 `.translation-response.json`, `.ko.B.vtt`, `.ko.B.srt`, `.response-validation.json`이며 기존 결과를 덮어쓰지 않는다.

## 재생과 확인 범위

준비용 임시 mediaKey는 Netflix watch ID가 아니다. 이 경우 응답 JSON을 브라우저의 다른 요청에 가져오지 말고, 검증된 B VTT를 해당 회차 작업실의 B에 직접 불러온다. 파일 원래 시각을 유지하며 보정은 적용하지 않는다.

실제 영상에서 초반·중간·후반·문제 컷 전후의 앵커를 측정해야 한다. 기본 offset 0·scale 1은 실측 결과가 아니다. A와 B가 다른 기준 시간축을 사용하면 각각 보정한다. 보정한 파일을 별도 출력한 뒤 재수입할 때는 같은 보정을 다시 적용하지 않는다.

구조 검증, ChatGPT의 의미 검토, 실제 영상 동기화는 각각 다른 완료 상태다.
