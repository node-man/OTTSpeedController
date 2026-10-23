# OTTSpeed 검증

## 실행한 검증과 별도 확인할 영역

이 변경은 Node 환경에서 파서·직렬화·번역 JSON 계약과 DOM/Chrome API 모형의 상태 전환을 검증했다. 로컬 개발 환경에는 Chromium 실행 파일이 없어 브라우저 smoke가 `BLOCKED`를 반환했다. **실제 Chromium 검증은 GitHub Actions의 `Chromium extension smoke` 결과를 별도로 확인한다. Netflix/YouTube 실제 재생은 이 CI와 별개의 미검증 영역이다.** `BLOCKED`는 통과와 구분한다. 정확한 테스트 개수와 결과는 PR 실행 기록을 기준으로 한다.

## 필수 자동 검사

```bash
npm run check
npm test
npm run package
```

Node 20 이상이면 외부 패키지 설치 없이 실행한다.

| 파일 | 검증하는 위험 |
|---|---|
| `tests/subtitle-core.test.js` | SRT/VTT 오류·크기 제한·ID·중첩·경계·해시·미완성 응답·generic/file 식별 |
| `tests/browser-harness/controller.test.mjs` | paused seek·역탐색·전체화면 분기·원자적 로드·CSS 복원·트랙별 시간·늦은 콜백 |
| `tests/browser-harness/content.test.mjs` | 배속 회귀·입력창 단축키·영상 교체·복원 경쟁·HTTP UUID·file URL |
| `tests/browser-harness/popup-background.test.mjs` | 다른 탭 메시지 차단·작업실 탭 바인딩·워커 재시작·저장 세션 조회 |
| `tests/browser-harness/workspace.test.mjs` | 파일·JSON 왕복·A 보존·영상 변경·polling 경합·저장 후 전달 실패·작업실 동시 편집 |

모든 저장소 테스트 문장은 직접 작성한 합성 자료다. 사용자 보유 작품 자막을 커밋하지 않는다.

## 실제 Chromium smoke

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
