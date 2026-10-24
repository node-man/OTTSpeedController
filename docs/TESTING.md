# OTTSpeed 검증

## 실행한 검증과 별도 확인할 영역

이 변경은 Node 환경에서 파서·직렬화·번역 JSON 계약과 DOM/Chrome API 모형의 상태 전환을 검증했다. 로컬 개발 환경에는 Chromium 실행 파일이 없어 브라우저 smoke가 `BLOCKED`를 반환했다. **실제 Chromium 검증은 GitHub Actions의 `Chromium extension smoke` 결과를 별도로 확인한다. Netflix/YouTube 실제 재생은 이 CI와 별개의 미검증 영역이다.** `BLOCKED`는 통과와 구분한다. 정확한 테스트 개수와 결과는 PR 실행 기록을 기준으로 한다.

## 필수 자동 검사

```bash
npm run check
npm test
npm run package
```

Node 20 이상에서 `npm ci` 후 실행한다. MCP 검사는 루프백 HTTP와 임시 파일의 원자적 이름 변경이 필요하므로 이를 차단하는 샌드박스에서는 해당 권한으로 실행한다.

| 파일 | 검증하는 위험 |
|---|---|
| `tests/subtitle-core.test.js` | SRT/VTT 오류·크기 제한·ID·중첩·경계·해시·미완성 응답·generic/file 식별 |
| `tests/subtitle-catalog.test.mjs` | 이전 버전·부분 B 병합·요청 근거 보존·시간 연결·메타데이터/회차 검색·백업 해시와 인증정보 제외 |
| `tests/subtitle-preparation.test.mjs` | SMI 상태 이벤트·명시한 복구만 허용·동일시각 발화 보존·보충 슬롯 해시·분할 소유권·검증 전 B 출력 방지 |
| `tests/netflix-capture.test.mjs` | Netflix manifest 구·신 필드·트랙 URL·회차 일치·VTT/TTML 원문 항목 수 대조·불완전 자료의 전편 판정 차단 |
| `tests/translation-bridge.test.mjs` | 고정 Netflix 스냅샷·A 제외·분할 소유권·전편 읽기·연속 앞부분 공개·동시각 경계 보류·부분 진행 재시작/수정·전편 확정·공식 MCP HTTP 왕복·Origin/토큰 경계 |
| `tests/workspace-agent.test.mjs` | 공식 요청 모형·미설정 복사 유지·동시/재시작 중복 방지·응답 유실 재시도·상태 식별·실행/자막 완료 구분·토큰/오류 비공개·Windows DPAPI 로드 |
| `tests/translation-batch.test.mjs` | 회차 순서·재사용·재시작·회차별 진행·원문 변경/손상 격리·묶음 공식 요청의 동일 재시도·HTTP 인증/Origin |
| `tests/translation-worker.test.mjs` | 작업실 없이 부분→전편 수신·GET 전용·워커 재시작·회차 변경 격리·설정/A 보존·해시 오류·오래된 진행·수동 B 보호 |
| `tests/browser-harness/controller.test.mjs` | paused seek·역탐색·전체화면 분기·원자적 로드·CSS 복원·트랙별 시간·늦은 콜백 |
| `tests/browser-harness/content.test.mjs` | 배속 회귀·입력창 단축키·영상 교체·복원 경쟁·HTTP UUID·file URL |
| `tests/browser-harness/popup-background.test.mjs` | 번역 버튼의 프롬프트 복사·새 탭 미생성·실패 안내·팝업 전용 메시지 인증·다른 탭 메시지 차단·고급 작업실 탭 바인딩·저장 세션 조회 |
| `tests/browser-harness/workspace.test.mjs` | 파일·JSON 왕복·A 보존·영상 변경·polling 경합·저장 후 전달 실패·작업실 동시 편집·브리지 B 수신/중복 방지·회차 변경 중 원래 회차 저장 |
| `tests/browser-harness/library.test.mjs` | 영상 없는 목록·검색·문자열 미리보기·시간 비교·버전 선택·메타데이터·내보내기·백업/복원·묶음 준비 |

모든 저장소 테스트 문장은 직접 작성한 합성 자료다. 사용자 보유 작품 자막을 커밋하지 않는다.

2026-10-24 라이브러리 목표 실행에서는 125개 자동 검사가 통과했다. 별도의 localhost 합성 UI를 인앱 브라우저로 열어 실제 IndexedDB에서 저장·이전 버전 보존·오래된 쓰기 거부·기존 회차 복원 보호·손상 백업 거부를 확인했다. 메타데이터의 새로고침 뒤 보존, `S02E03` 검색, EN/A/B 시간 비교도 확인했다. 이것은 설치된 Chrome 확장·Netflix·공식 Agent의 실계정 검증을 대신하지 않는다.

`node tests/library-preview.mjs`는 공개 파일 allowlist와 합성 원문만 제공하는 임시 localhost 검사 서버다. 실제 브리지 통신은 차단하며 Chrome 확장 저장소와 분리된다. 종료는 stdin의 `stop` 또는 해당 검사 프로세스 종료로 수행한다. 테스트 화면을 실제 자막 라이브러리로 사용하지 않는다.

후속 변경의 카탈로그/UI 검사 13개는 요청 해시 재계산, 같은 ID/시각을 가진 다른 원문 감지, 백업 뒤 원문 연결 근거 유지, 과거 묶음 재선택 시 실행/자막 선택 불변을 포함한다. 합성 UI에서도 정상 연결과 `원문 변경` 분류를 확인했다. 전체 검사 최초 125개와 이 변경 부분의 재검사 결과를 구분해 기록한다.

계정 지원 범위 확인 뒤 라이브러리 UI 검사 8개를 통과했다. 미설정 상태의 자동 버튼 숨김·복사 기본 경로, 준비 상태 조회, 공식 요청 접수/응답 유실 뒤 중복 복사 차단을 포함한다. 합성 상위 응답을 사용하며 실제 Pro 계정에서 Workspace Agents를 실행했다는 뜻이 아니다.

사용자가 Workspace Agents와 확장 식별을 보류한 뒤 복사+MCP 범위를 계속했다. 회차별 분할 진행표·수신 재개·원문 변경 거부·기존 시청용 구독 유지·보관용 수신의 워커 재시작 후 A/B·설정 보존을 추가했고 전체 자동 검사 **135개**를 통과했다. 현재 검증 로그는 개인 디렉터리의 `copy-mcp-continuation-tests.log`다. 합성 브리지 응답을 사용하는 독립 브라우저에서 진행표와 수신 재개 UI도 확인했다. 실제 설치 확장·Netflix·번역 의미 검증은 사용자 요청에 따라 별도 보류한다.

## 실제 Chromium smoke

2026-10-24 백그라운드 수집 후속 개발은 전체 자동 검사 **150개**, 문법/에셋 검사, 33개 배포 파일의 소스 SHA-256 일치 검사를 통과했다. 새 검사는 바이트/BOM·VTT/TTML 독립 파싱, 시청 탭 대기, 전용 비활성 탭, 원문/A/B 보존, M7020·로그인·시간 제한, 워커 재시작의 소유 표식 복구, 사용자 탭 선택·이동 보호, 생성/다운로드/저장 직전 취소를 포함한다. 격리 localhost 브라우저에서 회차 등록·대기·일시정지 화면도 확인했다. 실제 Netflix 백그라운드 수집은 미확인이다. [범위와 제약](BACKGROUND_COLLECTION.md), 개인 로그 `background-collection-tests.log`와 화면 `background-collection-ui.png`를 참고한다.

설치된 Playwright와 Chromium이 필요하다. 이 스크립트는 브라우저를 내려받지 않는다.

```bash
# 개발자가 별도로 Playwright와 브라우저를 준비한 환경에서 실행
npm run test:browser

# 별도 실행 파일을 지정할 때
OTTSPEED_CHROMIUM_PATH=/path/to/chromium npm run test:browser
```

`tests/smoke.mjs`는 새 임시 프로필에 unpacked 확장을 로드하고 로컬 합성 WAV와 직접 작성한 자막으로 검증한다. 기존 로그인 프로필을 읽지 않는다. Chromium이 없으면 종료 코드 2, 테스트 실패면 1, 완료면 0이다.

[CI workflow](../.github/workflows/test.yml)는 Playwright 1.62.1과 해당 Chromium을 설치해 같은 스크립트를 실행한다. 작업실 UI 파일 불러오기·실제 IndexedDB 저장·새로고침 복원·작업실 간 충돌도 합성 파일로 확인하고 화면/실패 진단 자료를 짧게 보관한다. CI가 실행되지 않았거나 실패하면 브라우저 검증 완료로 간주하지 않는다.

확인 대상은 video 감지, 배속, A/B·영한 표시, pause/seek·역탐색, 중첩 cue, 빈 구간, 문자열 XSS 방지, 컨테이너 전체화면, video 자체 전체화면의 명시적 한계, SPA 영상 변경, video 제거, 입력창 단축키다. 실제 서비스의 자막 추출 가능성과 번역 의미 품질은 이 smoke 범위 밖이다.

## 실제 영상 확인 순서

2026-10-24 [로그인된 headless 수집 도구](HEADLESS_CAPTURE.md)의 실제 시험에서는 E03 1,831개·E04 1,867개 영어 CC 전량 확보와 별도 `inspect-netflix-capture.mjs` 검사를 통과했다. 원본 바이트/BOM·모든 cue·입력 항목·VTT 왕복을 대조했다. 재사용한 수집/독립검사 모듈의 합성 회귀 21개도 통과했다. 실제 원문 확보 결과를 일반 비활성 탭 로드·영상 재생 완료·번역/싱크 평가의 증거로 확대하지 않는다.

1. `chrome://extensions`에서 로드하고 영상 탭을 새로고침한다. worker/content 오류를 확인한다.
2. 같은 회차의 영문과 한글 A, 비교할 B를 불러온다. 예상한 탭과 영상 ID인지 확인한다.
3. 1×·1.5×·2×에서 재생, 일시정지 상태 탐색, 앞뒤 이동을 확인한다.
4. A/B 전환과 영한 병기, 각 트랙 offset을 확인한다. 양수 offset이 실제로 늦게 표시되는지 본다.
5. 초반·중간·후반과 인트로/컷 전후를 대조한다. 시간 배율만으로 맞지 않으면 판본 차이로 기록한다.
6. 사이트의 전체화면 버튼으로 표시를 확인하고, 전체화면 해제·자막 비활성화·빈 구간에서 기본 자막이 복원되는지 확인한다.
7. 다음 회차로 이동해 이전 자막이 사라지는지 확인한다. 기존 회차로 돌아오면 그 회차의 저장 파일만 복원되어야 한다.
8. 작업실·영상 탭 재시작과 MV3 worker 종료 후 저장 세션 복원을 확인한다.
9. 작은 합성 요청으로 JSON 전체 왕복을 확인한다. ID 하나를 뺀 응답은 거부되어야 하며 기존 A/B를 바꾸면 안 된다.
10. 실제 대사의 정치·법률 의미, 존댓말 관계, 농담, 누락·과잉 의역과 읽기 편한 길이를 별도로 검토한다.

오류를 기록할 때는 OS·Chrome 버전, 확장 버전, 사이트와 영상 ID, 시간대, 동작 순서, 기대/실제 결과를 남긴다. 자막 본문 전체나 계정 정보가 들어간 URL은 공개 이슈에 붙이지 않는다.

## OTTDeck 모듈화 회귀 검사

`tests/architecture.test.mjs`는 기존 CLI와 새 기능 모듈이 같은 클래스를 제공하는지, 저장·연결 식별자가 유지되는지, 송신자 검사가 실행보다 앞서는지, 공통 통신 목적지가 루프백에 고정되는지, 호스트 코드가 확장 배포물에서 제외되는지 확인한다. 기존 팝업·라이브러리·작업실·수신 워커 검사도 실제 공통 통신 모듈을 실행한다.

Windows에서는 `powershell.exe -NoProfile -File tests/native-host.test.ps1`로 개인 프로필과 분리한 JSON/YAML 설정 조회·C# 컴파일·프레임 입출력·출처/명령 제한을 검사한다. 레지스트리, 실제 터널, 모델 호출은 사용하지 않는다. GitHub Actions는 Linux 회귀·패키징, Windows 네이티브 계약, Chromium 확장 smoke를 별도 작업으로 실행한다.

모듈화 중인 실제 설치를 검사하려고 현재 서비스나 사용자 시청 탭을 재시작하지 않는다. 새 빌드는 별도 `dist/OTTDeck-<version>`에 만들고, [기존 설치 갱신 정책](COMPATIBILITY.md)에 따라 활성화한다.
