# Workspace Agents 공식 실행 연결

2026-10-24. 구현 목표는 `번역 시작 → 공식 Workspace Agent 실행 → 기존 OTTSpeed MCP로 원문 읽기/분할 저장/전편 확정 → 확장 B 수신`이다. ChatGPT 웹 화면 조작이나 번역 모델 API 호출을 사용하지 않는다.

## 계정 지원 범위와 기본 방식

확인한 공식 문서는 Workspace Agent 생성에 기능 접근 권한이 있는 ChatGPT Business·Enterprise·Edu 워크스페이스를 요구한다. 개인 Pro만 사용하는 환경의 기본 경로는 **번역 시작 → 프롬프트 복사 → 일반 ChatGPT의 OTTSpeed 앱에 전달 → MCP 분할 수신**이다. Workspace Agents는 선택적인 연동 코드로 보존하며 새 구독·권한·키를 자동으로 준비하지 않는다. [공식 지원 조건](https://developers.openai.com/api/docs/guides/agent-builder/migrate-from-agent-builder#option-2-create-a-workspace-agent-from-the-export)

개발자 플랫폼의 Agents·Environments·Sessions와 ChatGPT Workspace Agents를 구분한다. 개발자 플랫폼의 API 키로 이 경로를 활성화하지 않는다. [공식 설정 예제](https://developers.openai.com/cookbook/examples/chatgpt/workspace_agents/workspace-agents-api-trigger)

라이브러리는 인증된 로컬 준비 상태 조회에서 공식 연결이 준비된 경우에만 자동 실행 버튼을 제공한다. 미설정이거나 준비 상태를 읽지 못하면 프롬프트 복사를 기본으로 안내한다. 이미 공식 실행 기록이 있거나 실행 요청 결과가 불명확하면 중복 번역을 피하도록 복사를 보류하고 같은 요청의 상태 확인을 유지한다. 계정 지원 여부를 설정 값만으로 보증하지 않는다.

## 실행 구조

팝업은 기존 확장 Origin과 페어링 토큰으로 로컬 브리지의 `POST /extension/jobs/<jobId>/start`를 호출한다. 요청 본문은 빈 객체이며 임의 프롬프트·주소·원문을 주입할 수 없다. 브리지가 저장된 고정 작업에서 공통 번역 지시를 만든다. Workspace Agent 토큰은 브리지 프로세스 안에만 존재한다. 확장의 백그라운드 요청은 계속 GET 전용이며, 최초 페어링과 실행 POST에는 기존 허용 Origin이 필요하다.

[공식 실행 문서](https://developers.openai.com/workspace-agents/trigger-runs)를 따라 게시된 `agtch_` API 채널에 요청하고 beta 실행 ID가 있으면 상태를 확인한다. 실행 결과 본문은 이 API에서 받지 않는다. 에이전트가 기존 MCP의 다음 도구를 실제로 호출해야 자막을 얻는다.

1. 해당 jobId의 `get_translation_job`과 모든 `read_subtitle_chunk`를 읽는다.
2. 첫 분할부터 `save_translation_chunk`에 번역을 저장한다.
3. 모든 분할을 저장한 뒤 `finalize_translation`을 호출한다.

원문·A를 보존하고 B의 ID/시각/해시 계약은 그대로 유지한다. 실행 지시는 `subtitles/translation-prompt.js`에서 복사 모드와 공유한다. 용어·부정·숫자·주체·말투를 보존하고 선행 문맥은 S01~S02E02로 제한한다. 게시 에이전트의 모델·도구 권한·실제 동작은 별도 확인해야 한다.

## 중복과 실패 처리

- 외부 요청 전 별도의 `private-subtitles/bridge/workspace-agent-runs/<jobId>.json`에 실행 의도와 재시도 키를 원자적으로 저장한다. 기존 번역 작업 파일은 실행 상태 때문에 변경하지 않는다.
- 같은 작업/원문/채널/프롬프트의 재시도는 동일 `Idempotency-Key`와 입력을 사용한다. 접수된 실행은 다시 POST하지 않는다. 응답 유실 때는 접수 불명 상태를 보존하고, 명시적인 재시도만 같은 이벤트로 수행한다.
- 429는 대기 간격을 둔 재시도를 허용한다. 401/403, 실행 불가, 터미널 실행 실패는 진단 상태로 남긴다. 임의로 새 이벤트를 만들어 자동 재실행하지 않는다.
- 상태 조회는 실행별 최소 15초 간격이다. 상위 응답이 느려도 로컬 자막 진행 목록과 B 수신을 막지 않도록 비동기로 갱신한다.
- 실행 `completed`와 자막 전편 확정은 별도다. 실행이 끝났어도 MCP finalize 결과가 없으면 확정 대기로 표시한다. 중단·외부 도구 대기·실패도 전편 완료가 아니다.
- 상위 오류 본문·토큰·헤더·자막 본문은 실행 이력이나 확장에 반환하지 않는다. API 주소는 고정하고 redirect를 따라가지 않는다. 반환된 대화 URL은 검증만 하고 자동으로 열거나 읽지 않는다.

## 설정과 준비 상태

현재 전용 채널 ID·토큰은 지정된 환경/설정 위치에 없으며 실제 Workspace Agent 호출·번역 반환은 미검증이다. 사용자 없이 관리자 설정이나 토큰을 만들지 않는다. [공식 인증 문서](https://developers.openai.com/workspace-agents/authentication)에 따르면 Workspace Agents와 개인 토큰 생성을 관리자 설정에서 허용해야 하며 Workspace Agents 범위의 토큰을 사용한다. 기존 Tunnels Read/Use 키, 확장 페어링 토큰, 일반 Platform API 키를 대신 사용하지 않는다.

게시할 에이전트는 현재 OTTSpeed MCP 앱을 사용할 수 있어야 한다. 작업 ID를 받으면 위 세 단계로 실행하고, 번역은 ChatGPT가 직접 수행하며 Codex/다른 모델 API에 위임하지 않도록 구성한다. API 채널 게시와 이 도구 접근의 실제 확인은 계정 의존 작업이다.

### 로컬 진단

```powershell
npm run workspace-agent:check
node scripts/workspace-agent-check.mjs --job FIXED_JOB_UUID
```

진단은 기본적으로 외부 요청 없이 로컬 설정과 고정 작업을 확인한다. 미설정은 종료 코드 2다. `ready=true`는 로컬 설정이 갖춰졌다는 뜻이며 실제 권한·연결·번역 성공을 보증하지 않는다. 완료된 작업은 다시 실행하지 않는다. `--job UUID --execute`를 명시한 경우에만 실행 요청을 보낸다.

### 이미 발급된 전용 토큰을 설정하는 방법

다음은 추후 계정 준비가 된 상태에서 사용할 진입점이며 이번 작업에서 실행하지 않았다. 토큰을 명령줄 인자나 문서에 넣지 않는다.

```powershell
powershell -NoProfile -File scripts/configure-workspace-agent.ps1 -TriggerId agtch_PUBLISHED_CHANNEL -Enable -PromptForToken
```

이 스크립트는 기존 전용 토큰을 숨긴 입력으로 받아 현재 Windows 사용자 DPAPI로 `workspace-agent-token.dpapi`에 보관하고, 비밀값 없는 `workspace-agent.json`을 생성한다. 기존 파일을 덮어쓰지 않는다. `-PromptForToken` 없이 전용 토큰 환경변수도 없으면 질문하지 않고 종료한다. 별도 등록이나 키 발급은 수행하지 않는다.

환경으로만 구성할 때는 브리지 프로세스에 `OTTSPEED_WORKSPACE_AGENT_ENABLED=1`, `OTTSPEED_WORKSPACE_AGENT_TRIGGER_ID`, `OTTSPEED_WORKSPACE_AGENT_TOKEN`을 전달한다. 일반 OS 로그인/자동 시작 등록은 하지 않는다. 설정은 브리지 시작 시 읽는다.

## 미설정·호환 경로

미설정 상태에서는 기존 프롬프트 복사가 동작한다. 설정된 실행이 접수됐거나 접수 불명인 경우 자동으로 복사 경로로 전환하지 않아 중복 작업을 피한다. ChatGPT 탭·작업실 탭은 자동으로 열지 않는다.

새 브리지와 확장 패키지를 함께 사용해야 한다. 설치된 확장의 실제 팝업·클립보드·게시 에이전트·MCP 왕복은 합성 검사와 별개의 실사용 확인 항목이다.
