# 전 시즌 headless 수집 대기열

`npm run netflix:collect-series`는 전용 Netflix 프로필만 사용하는 호스트 도구다. 현재 시청 Chrome에 연결하지 않으며 확장 관리 페이지나 사용자 탭을 열거나 제어하지 않는다. 기존 단일 회차 시험은 [HEADLESS_CAPTURE.md](HEADLESS_CAPTURE.md)를 참고한다.

## 실제 회차 발견

2026-10-24 Netflix의 The West Wing 상세 화면에서 시즌 메뉴와 펼친 회차 카드를 읽었다. 메뉴의 예상 개수와 실제 카드 수, 회차 번호, 제목, 카드 DOM의 `video_id` 일치를 검사한다. 숨은 카탈로그/플레이어 API나 연속 ID 추측을 사용하지 않는다.

| 시즌 | Netflix에 표시된 회차 수 |
| --- | ---: |
| 1 | 22 |
| 2 | 22 |
| 3 | 23 |
| 4 | 23 |
| 5 | 22 |
| 6 | 22 |
| 7 | 22 |
| 합계 | 156 |

마지막 카드는 **S07E22 Tomorrow**, 영상 ID `70262239`다. 이 개수는 현재 Netflix 편성의 관측값이며 다른 서비스의 회차 번호를 대입하지 않는다. 발견 기록은 `private-subtitles/series-capture/west-wing/inventory.json`, 시즌별 기록, 마지막 시즌 화면에 보존한다.

## 실행과 재개

```powershell
npm run netflix:collect-series -- --discover-only
npm run netflix:collect-series -- --limit 2
npm run netflix:collect-series
npm run netflix:verify-series
```

로그인은 기존 `npm run netflix:login`으로 정상 수행한 전용 프로필만 재사용한다. Netflix가 프로필 선택을 다시 요구하면 `private-subtitles/headless-auth/profile-choice.json`의 사용자 지정 `profileName`과 정확히 같은 표시 이름을 선택한다. 설정이 없으면 임의의 계정 프로필을 고르지 않고 중단한다. 로그인 만료·인증 실패를 수집 성공으로 기록하지 않는다.

한 개의 프로필 lock과 headless 브라우저로 한 회차씩 수행한다. 회차마다 새 수집 페이지만 열고 자막 확보 후 닫는다. 요청·표시 오류는 회차별로 최대 3회 재시도하고 실패 기록을 보존한다. 로그인 오류는 전체 실행을 멈춘다. 초기 회원 화면 로드는 최대 3회 재시도한다.

`queue.json`은 임시 파일 작성 후 rename으로 원자 저장하며 `summary.json`에 전체/검증/실패/대기 수와 최종 회차 여부를 기록한다. 재실행 시 중단된 항목과 실패 항목을 이어간다. 영상 ID나 회차 목록이 기존 대기열과 다르면 거부한다.

## 완료 판정

대기열이 모두 끝난 뒤 `netflix:verify-series`는 저장된 각 원본을 다시 읽어 동일한 회차·바이트 해시·완전한 입력 항목·영어 VTT와의 일치를 검사한다. 전체가 통과한 경우에만 `archive-index.json`과 `COLLECTION-RESULT.md`를 생성한다. 인덱스에는 회차별 원본/검사/VTT 경로와 원본 해시·파이프라인 sourceHash를 보존하며 번역 작업은 생성하지 않는다.

각 자막은 기존 manifest 수집기로 현재 영상 ID에 맞는 영어 전체 텍스트 파일을 받고, `capture-validation.js` 및 별도 Node 프로세스의 `inspect-netflix-capture.mjs`로 두 번 검사한다. 원본 바이트 SHA-256/BOM·회차·언어·전체 파일 프로필·모든 입력 항목·독립 재파싱·VTT 왕복이 일치해야 한다. 기존 파일도 재검사 후에만 재사용한다. 변조되거나 깨진 기존 파일은 보존하고 새 시도 폴더에 다시 수집한다.

원본·정규화 영어 VTT·검사 JSON은 회차별 새 시도 폴더에 보존한다. A/B 파일, 기존 번역 요청, 시청 설정은 변경하지 않는다. 모든 156개 항목의 독립 검사가 성공해야만 대기열 `complete`가 된다. 실제 진행 상태는 private `summary.json`과 각 검사 기록을 확인한다. 회차 목록 발견, 수집 명령 실행, 마지막 시각만으로 전 시즌 확보를 주장하지 않는다.

이 수집 도구의 결과는 호스트의 개인 파일 보관소다. 후속 [라이브러리 연결](SUBTITLE_LIBRARY.md)에서 인증된 로컬 브리지를 통해 수집 원문·작품/회차 정보·완료된 모델 번역을 확장 IndexedDB로 가져오도록 추가했다. 전 시즌 번역 시작은 별도이며, 전편 텍스트 파일 확보는 모든 음성의 전사 정확성·번역 품질·영상 싱크 검증과 구분한다.

## 실제 전 시즌 수집 완료

2026-10-24 **17:56:04 KST**에 S01E01부터 S07E22 **Tomorrow**까지 **156/156회차**, **279,524개 cue**가 수집 대기열의 독립 검사를 통과했다. **17:56:22 KST**에 저장된 전체 원본과 VTT를 다시 읽는 최종 검사도 통과했다. 실패 0, 경고 0, 원본 리소스 합계 45,296,374바이트다. 사용자가 수집용 프로필을 지정한 뒤 전용 headless 프로필에서만 수행했으며 사용자 시청 탭에 제어 명령을 보내지 않았다.

전체 회차별 경로·해시는 개인 `private-subtitles/series-capture/west-wing/archive-index.json`, 사람이 읽는 결과는 같은 폴더의 `COLLECTION-RESULT.md`에 보존한다. 기존 원본/A/B와 S02E03 확정 번역 작업은 변경하지 않았다. 이 완료는 영어 자막 원본 수집이며 전 시즌 번역 완료를 뜻하지 않는다.
