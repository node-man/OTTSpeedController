# Netflix 백그라운드 사전 수집

2026-10-24 구현한 **일반 Chrome 비활성 탭의 실험용 대기열**이다. 이 대기열의 실제 수집 성공은 미확인이다. 별도로 [로그인된 headless 실행 도구](HEADLESS_CAPTURE.md)에서는 E03 1,831개·E04 1,867개 영어 CC 전체 파일 확보와 독립 검사에 성공했다. 초기 빈 프로필의 NSES-404 실패는 과거 기록이며 최신 성공과 구분한다. 브라우저 엔진 자체가 없는 새 다운로드 경로는 제공하지 않는다.

## 사용 흐름

팝업 → 자막 라이브러리 → **Netflix 사전 수집**에서 `/watch/<영상 ID>` 주소 또는 숫자 영상 ID를 한 줄에 하나씩 등록한다. 한 번에 100개, 보관 기록은 500개까지다. 알고 있는 시즌 회차 주소를 모아 등록할 수 있으며 시즌 회차 목록을 자동 발견하거나 ID를 추측하는 기능은 없다.

Chrome 실행과 기존 Netflix 로그인이 필요하다. 입력은 확장의 로컬 대기열에 보관한다. ChatGPT 전송이나 모델 실행은 이 단계에서 하지 않는다.

1. 같은 회차에 전편 수집 근거가 있는 원문이 있으면 재사용한다.
2. 다른 Netflix 시청 탭이 있으면 일시정지된 탭도 포함해 대기한다. 사용자 탭은 재생·정지·탐색·새로고침하지 않는다.
3. 대기열이 생성한 비활성 탭 한 개에서 해당 회차 manifest를 기다린다. 수집 탭에는 고유한 소유 표식을 부여하고 그 탭의 숨겨진 video에만 자동 재생 일시정지를 적용한다.
4. 현재 회차의 영어 전체 파일을 수집한다. 회차·영어·단일 전체 파일 프로필·문서 완전성·입력/수용/제외 개수·ID·시각 범위·0/1 보정을 확인한다. 별도 isolated world에서 원본 UTF-8 바이트 SHA-256/BOM과 독립 재파싱 결과도 대조한다.
5. 통과한 영어 원문과 원본 텍스트를 라이브러리에 보관한다. 기존 원문은 버전 이력으로 보존하고 A/B·표시 설정을 유지한다. 원문이 바뀌면 기존 요청을 재사용하지 않도록 대기 요청을 해제하고 이전 수신 연결을 중지한다.
6. 비활성이며 회차·소유 표식이 여전히 일치하는 수집 탭만 닫고 다음 회차를 진행한다. 사용자가 탭을 선택하면 소유 표식을 해제하고 수집을 중단한다. 사용자가 이동시킨 탭은 자동으로 닫지 않는다.
7. 저장 후 기존 **선택 회차 번역 준비 → 묶음 프롬프트 복사 → ChatGPT OTTSpeed MCP → 부분 B 수신** 경로를 사용한다. 수집만으로 번역 완료를 표시하지 않는다.

## 중단·복구

`수집 일시정지`, `수집 재개·실패 재시도`, 회차별 `취소`를 제공한다. 작업실/라이브러리 탭을 닫아도 대기열은 확장 storage에 남는다. MV3 worker가 다시 시작하면 alarm과 저장한 탭 ID·소유 표식으로 이어간다. 탭 생성 직후 worker가 사라진 경우에도 같은 소유 표식을 먼저 찾아 중복 생성을 피한다.

Manifest 대기는 90초, 수집 메시지는 35초 이내로 제한한다. 로그인 페이지, Netflix M7020, 회차 변경, 사용자 탭 선택, 누락된 전편 근거, 원문 해시 불일치는 성공으로 처리하지 않는다. 식별되지 않는 탭의 닫기는 보류하며 제한된 정리 재시도 후 확인 필요 상태를 남긴다. 재시도는 보관된 원문을 지우지 않는다.

## 구현·검증 상태

| 항목 | 상태 |
|---|---|
| 직렬 대기열·비활성 탭·시청 탭 대기·취소/일시정지·재시작 복구 | 구현, 합성 Chrome API 검사 통과 |
| 파일 바이트 해시·BOM·VTT/TTML 독립 재파싱 | 구현, 합성 원문 검사 통과 |
| 라이브러리 등록·상태표·일시정지 화면 | DOM 검사와 격리 localhost 브라우저에서 확인 |
| 일반 Chrome 비활성 탭 경로의 manifest·EP4 원문 확보 | **미확인**. 과거 일반 별도 탭은 M7020 오류였음. 별도 headless의 E04 성공과 구분 |
| 별도 로그인된 headless 도구의 실제 원문 확보 | **E03·E04 전편 확보·독립 검사 성공**. 이 비활성 탭 대기열과 별도 경로 |
| Chrome 없이 이미 보관된 원문으로 묶음 준비 | 기존 구현·확인 유지 |
| Chrome/다른 브라우저 없이 미수집 회차의 원문 확보 | 공식 지원 API 미확인, 미구현 |
| 시즌 회차 주소 자동 발견 | 미구현. 명시한 회차 목록만 수집 |

전체 자동 검사 **150개**, 문법/에셋 검사, 배포 33개 파일의 소스 SHA-256 대조를 통과했다. EP3 기존 작업 파일의 SHA-256도 이전과 일치한다. 이 검사 결과는 실제 Netflix 새 수집 경로의 성공을 뜻하지 않는다.

현재 설치 확장을 새 코드로 다시 로드하는 UI 조작은 브라우저 URL 정책으로 차단돼 있다. 이를 우회하거나 사용자 시청 탭을 변경해 시험하지 않았다. 사용자의 질문·수동 작업 금지 지시에 따라 재로드 요청 없이 패키지와 로컬 검증 결과를 준비했다. 합성 성공을 실제 Netflix 수집 성공으로 확대하지 않는다.

## 파일과 근거

- `subtitles/collection-queue.js`: 대기열, storage/alarms, 소유 탭 관리, 라이브러리 보관.
- `subtitles/netflix-capture.js`: document_start 소유 guard와 isolated world 검증.
- `subtitles/capture-validation.js`: 원문 메타데이터·바이트·재파싱 검사.
- `tests/collection-queue.test.mjs`, `tests/netflix-capture.test.mjs`, 라이브러리/background 경계 검사: 직접 작성한 합성 자료만 사용.
- 개인 검증 자료: `private-subtitles/bridge/background-collection-tests.log`, `background-collection-ui.png`.

설계 근거: [Chrome tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)의 `active: false`·탭 상태·탭 통신, [MV3 worker 수명](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)의 비영속 전역 상태, [alarms API](https://developer.chrome.com/docs/extensions/reference/api/alarms)의 정기 깨우기. 기존 manifest의 content-script 접근 범위 안에서 동작하며 권한을 추가하지 않는다.

검토한 [Netflix 다운로드 안내](https://help.netflix.com/en/node/54816)는 앱 오프라인 다운로드를 설명한다. 독립 자막 파일 수집 API의 근거로 삼지 않는다. [자막 언어 안내](https://help.netflix.com/en/node/101798)에 따라 회차·지역의 트랙 가용성도 따로 확인해야 한다. 계정 쿠키 추출, 내부 플레이어 API, DRM 복호화, 만료된 URL 재사용은 구현하지 않았다.
