# OTTDeck 모듈 구조

OTTDeck은 재생·자막·수집·번역·개인 라이브러리를 연결하는 도구다. Chrome 확장, 로컬 서버, 모델 실행기는 별도 실행 경계를 가지며 기능 추가가 기존 저장 형식이나 연결 식별자를 바꾸지 않도록 구성한다.

## 책임과 의존 방향

| 경로 | 책임 |
|---|---|
| `shared/product.js` | 제품 표시명과 동결된 호환 식별자. 개인 계정·키는 포함하지 않음 |
| `shared/extension-assets.mjs` | 확장 배포에 포함할 공개 파일의 명시적 목록 |
| `modules/app/` | 기능 조립, 메시지 라우팅, 공통 송신자 정책 |
| `modules/playback/background.js` | 재생 탭의 상태·아이콘·저장 세션 전달 |
| `modules/capture/background.js` | 수집 대기열 작업의 등록과 접근 정책 |
| `modules/translation/background.js` | 번역 준비·수신·진행 조회의 등록과 접근 정책 |
| `modules/translation/job-store.mjs` | 고정 요청·분할·전편 확정·진행의 영속 저장 |
| `modules/translation/batch-store.mjs` | 회차별 고정 작업의 순서·묶음 관리 |
| `modules/translation/mcp-server.mjs` | 기존 다섯 MCP 도구의 계약과 감사 기록 |
| `modules/library/archive.mjs` | 검증된 보관 원문·완료 번역의 읽기 전용 공개 |
| `modules/library/mcp-registration.js` | 현재 원문과 MCP 작업의 자동 등록·동일성 확인. 번역 실행 없음 |
| `modules/runtime/bridge-http.js` | 팝업·작업실·라이브러리·수신 워커의 공통 HTTP 클라이언트 |
| `modules/runtime/bridge-server.mjs` | 루프백 API·MCP 전송·페어링·서버 조립 |
| `modules/runtime/http-policy.mjs` | 요청 크기·JSON 파싱·상수 시간 토큰 비교 |
| `modules/runtime/background.js` | 관리 화면에서만 허용하는 로컬 시작·상태 조회 |
| `subtitles/` | 자막 파서·계약·화면 표시·IndexedDB·수집/수신 엔진과 기존 UI 진입점 |
| `popup/` | 사용자가 누르는 재생·번역·연결 UI |
| `scripts/` | CLI·Windows 설치/기동 어댑터 및 기존 공개 import 호환 계층 |
| `scripts/runtime/config.ps1` | 기존 개인 프로필에서 터널·조직 식별자 조회. 키를 복호화하거나 실행하지 않음 |
| `native/` | Chrome 프레임 프로토콜로 고정된 시작·상태 명령만 처리하는 Windows 도우미 |

```mermaid
flowchart LR
    UI[팝업·라이브러리·작업실] --> Router[앱 라우터와 송신자 정책]
    Router --> Playback[재생]
    Router --> Capture[수집 대기열]
    Router --> Translation[번역 수신]
    Router --> Runtime[로컬 연결]
    UI --> HTTP[공통 HTTP 클라이언트]
    Translation --> HTTP
    HTTP --> Bridge[루프백 브리지]
    Runtime --> Native[Native Messaging 도우미]
    Native --> Task[Windows 감독 작업]
    Task --> Bridge
    Bridge --> Jobs[번역·묶음 저장소]
    Bridge --> Archive[라이브러리 보관소]
    GPT[ChatGPT] --> Tunnel[기존 Secure MCP Tunnel]
    Tunnel --> MCP[MCP 도구]
    MCP --> Jobs
```

`scripts/background.js`는 고정 진입점에서 의존 모듈을 불러오고 조립만 한다. 기능 모듈은 공통 라우터에 액션·송신자 정책·입력 조건·실행 함수를 등록한다. 같은 액션의 중복 등록은 오류다. 송신자 검사는 입력 검사와 실행보다 먼저 수행한다. 외부 웹페이지는 로컬 프로세스 시작 경로에 접근할 수 없다.

HTTP 클라이언트는 목적지를 루프백으로 고정하고 인증 헤더·JSON·제한 시간·오류 처리를 한 곳에서 관리한다. 각 화면은 UI와 업무 흐름만 담당한다. 번역 결과 수신 워커는 GET만 사용한다. 별도의 원문 등록 모듈은 작업 조회와 `POST /extension/jobs`만 사용한다. 서버의 페어링·저장·모델 실행 경계는 그대로 유지한다.

## 라이브러리와 MCP 등록

검증된 Netflix 영어 원문은 라이브러리의 보관소 가져오기 직후, 백그라운드 시작과 1분 주기, 새 수집 저장 직후에 등록을 재확인한다. 백그라운드는 기존 페어링 토큰이 있을 때만 연결한다. 미연결 시 원문을 보존하고 다음 주기에 재시도한다. 화면의 주기 확인은 30초 간격으로 합쳐 같은 작업을 중복 생성하지 않는다.

영상 식별자·원문 요청 해시·원본 파일 해시로 기존 작업을 재사용한다. 표시 시간 보정은 원문 등록에 반영하지 않는다. 연결 캐시는 현재 원문·수집 근거의 지문과 묶이며, 원문 변경이나 동시 저장 충돌 시 최신 세션을 다시 읽는다. A/B·원문·표시 설정은 이 캐시에 의해 바뀌지 않는다. 백업 복원은 연결 캐시를 신뢰하지 않고 다시 확인한다.

| 표시 | 의미 |
|---|---|
| 원문 보관 · 등록 전 / 등록 확인 전 | 원문은 있으나 현재 원문의 MCP 연결을 아직 확인하지 못함 |
| MCP 등록 실패 / 등록 실패 | 현재 원문의 수집 근거나 등록 응답을 확인하지 못함 |
| 번역 대기 / 등록됨 | 작업은 등록됐고 저장된 번역 분할은 없음 |
| 번역 중 | 실제 저장된 분할 또는 검증된 부분 B가 있음. 원문 읽기만으로 번역 중이라 표시하지 않음 |
| 번역 완료 · 수신 대기 | 서버 전편 확정은 확인했지만 일치하는 B가 아직 로컬에 없음 |
| 완료 | 현재 원문·요청·ID·시각에 일치하는 전편 B가 로컬에 있음 |
| B 보관 / 원문 변경 / 검사 필요 | 연결 미확인 B, 다른 원문의 번역 또는 검사 실패를 각각 구분 |

등록은 모델 호출·프롬프트 전송·묶음 생성과 별개다. 사용자가 선택한 회차만 고정 묶음에 넣고, 명시적인 복사 또는 실행 버튼에서 그 묶음을 전달한다. 다른 회차를 자동 실행하지 않는다. 외부에서 저장된 결과는 보관 버전으로 수신하며 이미 선택한 A/B를 바꾸지 않는다. 기존에 사용자가 재생을 선택한 수신 작업의 설정은 유지한다.

## 기능을 추가할 때

1. 해당 영역에 동작을 구현한다. DOM·Chrome API·로컬 서버 코드가 서로 의존하지 않도록 어댑터를 구분한다.
2. 백그라운드 액션이 필요하면 공통 라우터에 송신자 정책과 입력 조건을 함께 등록한다. `modules/app/background.js`에서 기능을 조립한다.
3. 브라우저 파일이면 `shared/extension-assets.mjs`에 추가하고 필요한 진입점에서 명시적으로 로드한다. 호스트 전용 코드를 확장에 통째로 포함하지 않는다.
4. 실제 위험을 확인하는 경계 검사를 추가한다. 원문·요청 해시, 다른 회차 적용 차단, 충돌·재시작·인증은 기존 검사를 유지한다.
5. 표시명 변경과 저장·통신 형식 변경을 구분한다. [호환 정책](COMPATIBILITY.md)을 확인한다.

동적 원격 플러그인이나 자동 코드 다운로드는 사용하지 않는다. 새 도구 추가에 불필요한 권한을 미리 부여하지 않는다. 현재 파서·오버레이·IndexedDB 엔진의 진입점은 유지하며 기능별 인터페이스를 통해 점진적으로 확장한다.

## 검사

`npm test`는 기능·계약·접근 경계를, `npm run check`는 문법·manifest·HTML·worker의 배포 의존성을 검사한다. `npm run package`는 허용된 파일만 `dist/OTTDeck-<version>`에 만든다. `npm run test:browser`는 기존 계정과 분리한 합성 미디어에서 Chromium 확장을 검사한다. 실제 Netflix 싱크·의미 품질·ChatGPT 대화 성공은 별도 증거가 필요하다.
