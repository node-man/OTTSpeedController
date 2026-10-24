# Netflix 원문 → ChatGPT MCP → B 자막

실제 Netflix 자막 수집은 [수집 검사](NETFLIX_CAPTURE.md)를 따른다. 이번 경로는 `mode=translate`, `reference=null`이며 기존 A·SMI·이전 번역을 입력에 넣지 않는다. 자막 ID와 시각은 Netflix 스냅샷 그대로 사용하고 공통·원문·B 보정은 0/1로 시작한다.

## 실행

### 확장에서 연결 시작 (Windows)

현재 Windows 사용자에 로컬 도우미를 한 번 등록한다. Node 의존성 설치와 기존 터널 키 설정은 먼저 필요하다.

```powershell
npm run runtime:install
```

이후 확장을 새로고침하면 팝업을 열 때와 **번역 시작** 전에 로컬 연결을 자동 준비한다. 영상이 없는 탭에서도 팝업의 **번역 연결 시작**을 사용할 수 있다. 라이브러리를 열거나 작업실에서 **브리지 연결**을 눌러도 같은 경로를 이용한다. Chrome 시작 이벤트도 연결을 준비하므로 Windows 로그인 자동 실행 트리거 없이 브라우저 사용 시 시작할 수 있다. 팝업의 준비 표시는 로컬 브리지·터널·감독 프로세스 상태이며 ChatGPT의 실제 호출 성공·번역 완료 표시는 아니다.

Chrome의 공식 [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)으로 설치된 `com.ottspeed.runtime`만 호출한다. 설치기는 Windows 기본 C# 컴파일러로 도우미를 만들고 HKCU에 등록하며 기본 허용 출처는 OTTSpeed 확장 한 개뿐이다. `nativeMessaging` 권한이 필요하다. 도우미는 고정된 `ensure`·`status`만 받는다. 임의 명령·경로·환경변수·자막·키를 인수로 받거나 반환하지 않는다. 웹페이지·콘텐츠 스크립트가 시작 요청을 전달하지 못하도록 백그라운드에서도 관리 페이지 URL을 제한한다.

이미 실행 중인 연결에는 재시작·중지·재페어링을 하지 않는다. Chrome이나 팝업의 연결이 끝나도 Windows 감독 작업은 계속 실행하는 구조다. GPT 자체의 번역 실행 상태는 별개이며 실제 Chrome 종료 재시작의 종단 검사는 아직 하지 않았다. 연결 버튼은 GPT 번역 요청을 자동 제출하지 않으며 프롬프트 복사 흐름을 유지한다. 다른 확장 ID라면 설치기에 `-ExtensionId`를 지정해야 한다.

2026-10-24 실제 컴파일된 도우미의 프레임 입출력·상태·기동·출처 제한·임의 명령 거부를 확인했고 브리지·감독 PID가 유지됐다. 확장 UI·송신자 제한·준비 실패 시 번역 시작 차단은 합성 검사로 확인했다. 현재 진행 중인 GPT 번역을 보호하기 위해 설치된 Chrome 확장을 새로고침하지 않았으므로, Chrome 버튼에서 `sendNativeMessage`를 거치는 최종 확인은 아직 하지 않았다. 개인 근거: `private-subtitles/bridge/native-host/`.

### 확장 없이 진단할 때

Node 20 이상에서 `npm ci` 후 다음을 실행한다. 확장만 설치할 때는 Node 의존성이 필요 없다.

```powershell
powershell -NoProfile -File scripts/start-translation-stack-task.ps1
```

Windows에서는 위 명령이 현재 사용자의 제한된 권한으로 `OTTSpeed-Translation-Stack` 작업을 시작한다. Codex 자식 프로세스 대신 Windows Task Scheduler가 감독 스크립트를 실행하므로 Codex 실행 세션과 분리된다. 브리지와 승인된 기존 DPAPI 키의 터널을 시작하고 30초마다 로컬 상태를 검사한다. 브리지 종료 시 재시작하며 터널 재연결 실패는 5분 간격으로 재시도한다. 모델 호출·번역 실행·새 키 생성은 하지 않는다. 로그인 자동 실행 트리거·저장된 계정 암호·관리자 권한은 추가하지 않는다. PC 재부팅 후에는 위 명령으로 다시 시작한다. 중지는 `Stop-ScheduledTask -TaskName OTTSpeed-Translation-Stack`으로 수행한다.

감독 상태는 `private-subtitles/bridge/stack-status.json`, 사건 기록은 `stack-supervisor.jsonl`에 남긴다. 이 상태는 로컬 프로세스 준비 여부이며 실제 ChatGPT 호출 성공 여부는 별도 검사해야 한다. 브리지만 단독 진단하려면 기존 `scripts/start-translation-bridge.ps1`도 사용할 수 있다.

기본 서버는 `http://127.0.0.1:43127`에만 바인딩한다. 기본 허용 확장 ID는 현재 설치본 `hegbpfhcjpghhhnmnjjedibpfblchefh`다. 다른 ID이면 `-ExtensionId`에 지정한다. 재시작할 때 기존 프로세스가 실행 중이면 중복 실행하지 않는다.

작업실에서 **브리지 연결 → Netflix 원문 번역 준비**를 누른다. 수집이 전편이고 입력·수용 개수가 같으며 제외 항목이 없는 영어 트랙만 요청으로 고정한다. 기존과 동일한 원문 해시·원본 자원 해시는 같은 작업을 재사용하고 원문이 바뀌면 새 작업으로 만든다. 검사를 끝낸 캡처를 개발자가 처음 이관하는 용도로만 `translation-bridge-seed.mjs`를 사용할 수 있다. 일반 사용 흐름에서 파일 이동은 필요 없다.

공식 자동 연결이 미설정이면 팝업의 **번역 시작**은 현재 영상의 영어 CC 우선 선택·전편 수집·고정 작업 준비 후 **그 작업의 시작 프롬프트를 클립보드에 복사**한다. 작업실·ChatGPT 탭을 자동으로 열거나 대화를 자동 전송하지 않는다. 복사 완료까지 팝업을 열어 두고, 일반 ChatGPT의 OTTSpeed 앱에 붙여넣어 한 번 보낸다. 복사 실패 시 팝업에 직접 복사할 프롬프트를 표시한다. 같은 원문으로 다시 누르면 기존 작업을 재사용한다. 원본 파일과 수집 기록은 해당 회차의 IndexedDB 세션에도 보관한다.

복사 완료 후 팝업과 작업실을 닫아도 확장 백그라운드가 결과를 수신한다. 준비된 첫 구간은 B로 적용되며 **처음부터 B로 재생**으로 시청할 수 있다. ChatGPT의 실제 번역 실행과 PC의 브리지·터널은 계속 필요하다. 확장은 ChatGPT 화면을 조작하거나 번역 모델 API를 호출하지 않는다.

## ChatGPT 연결

Workspace Agents 공식 실행 연결이 설정되면 팝업은 프롬프트 복사 대신 로컬 브리지를 통해 게시된 에이전트 실행을 요청한다. 에이전트는 아래와 동일한 MCP 도구로 분할을 저장한다. 미설정 상태는 복사를 유지한다. 접수 불명이나 실행 실패를 자막 완료로 처리하지 않는다. [적용·설정·검증 범위](WORKSPACE_AGENTS.md)를 따른다.

공식 [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)을 사용한다. Platform에서 터널을 만들고 사용할 ChatGPT 워크스페이스를 연결한다. 런타임 키의 주체에는 Tunnels Read + Use가 필요하다. 키는 환경변수로 참조하며 채팅·보고서·프로필 본문에 비밀값을 쓰지 않는다. 이 경로는 번역 모델 API를 호출하지 않는다.

```powershell
$env:CONTROL_PLANE_ORGANIZATION_ID = '터널을 소유한 조직 ID'
# CONTROL_PLANE_API_KEY는 별도의 안전한 로컬 입력 경로에서 설정한다.
tools/tunnel-client/tunnel-client.exe runtimes connect --alias ottspeed --tunnel-id TUNNEL_ID --organization-id $env:CONTROL_PLANE_ORGANIZATION_ID --mcp-server-url http://127.0.0.1:43127/mcp --profile ottspeed --profile-dir E:/Projects/OTTSpeed/private-subtitles/bridge/tunnel-profiles --runtime-api-key env:CONTROL_PLANE_API_KEY
tools/tunnel-client/tunnel-client.exe runtimes status ottspeed --json
```

프로필의 `control_plane.organization_id`에도 소유 조직 ID를 넣어 재시작 후 유지한다. 상태의 `process_running`, `healthy`, `ready`를 확인하되, **`ready=true`여도 실제 poll이 인증 오류를 반복할 수 있으므로 이것만으로 연결 성공을 보고하지 않는다.** 최근 poll 오류와 ChatGPT 도구 검색을 함께 확인한다. 런타임 키의 소유 조직도 반드시 일치해야 한다. `mismatched_organization`이면 다른 조직을 강제로 지정하지 않고 해당 터널 조직의 키를 사용한다.

Windows에서는 `scripts/connect-translation-tunnel.ps1`이 키를 숨긴 로컬 프롬프트로 받고, 터널 메타데이터 조회를 통해 키·조직·권한을 먼저 확인한다. 성공한 키만 새 런타임 프로세스에 전달하며 비밀값은 프로필·채팅·로그에 기록하지 않는다. 새 키 생성은 실행 직전 사용자 승인을 받아야 한다. 사용자가 생성·로컬 보관을 승인한 경우에만 `protect-translation-tunnel-key.ps1`로 일시 전달 파일을 현재 Windows 사용자의 DPAPI 암호문으로 저장하고 일시 파일을 제거한다. 이후 `connect-translation-tunnel.ps1 -UseSavedKey`로 재연결할 수 있다. 저장을 원하지 않으면 로컬 프롬프트로 매번 입력한다.

[공식 ChatGPT 연결 절차](https://developers.openai.com/plugins/deploy/connect-chatgpt)에 따라 플러그인 → 추가 → 사용자 지정 MCP 서버 추가에서 **Tunnel**과 해당 ID를 선택한다. 서버는 로컬 터널을 통해서만 접근하며 별도의 OAuth를 제공하지 않는다. 공개 HTTPS 주소를 만들지 않는다. 도구 다섯 개가 검색되는지 확인한 뒤 연결한 플러그인을 대화에서 선택하고 작업실의 시작 요청을 보낸다.

## MCP 도구와 검증

| 도구 | 동작 |
| --- | --- |
| `get_translation_job` | 회차·고정 요청 정보·전편 확보 근거·분할 진행·사전 맥락 |
| `read_subtitle_chunk` | 출력 대상 원문과 앞뒤 4개 읽기 전용 cue |
| `save_translation_chunk` | 해당 부분의 모든 `id,text` 저장, 기존 응답 검증기 재사용 |
| `finalize_translation` | 전체 병합·기존 전편 검증·응답 JSON·B VTT 확정 |
| `update_pretranslation_context` | S01~S02E02까지만 짧은 메모와 근거·revision으로 갱신 |

150개 단위 분할이며 마지막 부분만 더 작다. 모든 원문 분할을 읽기 전에는 저장을 거부한다. 참고 문맥 ID, 누락·중복·추가 ID, 빈 문안, 시각 필드, 다른 요청·원문·영상 메타데이터를 거부한다. 동일 저장·확정은 재시도할 수 있으며 확정 뒤 변경은 거부한다. 서버 재시작 후 요청·부분 응답·진행·확정 결과를 이어받는다. 사전 맥락은 미작성 상태로 시작하며 Codex가 사실이나 번역을 대신 만들어 넣지 않는다.

팝업에서 시작한 작업은 백그라운드가 3초 간격으로 조회하고, MV3 워커 휴면·재시작 시 30초 알람으로 이어받는다. 확정된 작업의 polling은 종료한다. 고급 작업실에도 별도 조회 기능이 있다. 일반 ChatGPT는 전편을 읽은 뒤 첫 분할부터 순서대로 저장한다. 서버는 **앞에서부터 연속으로 저장된 범위**만 `ottspeed.translation-progress`로 공개한다. 분할 경계에 동시각/중첩 cue가 걸리면 그 묶음이 모두 저장될 때까지 끝부분을 보류한다. 뒤쪽 분할만 먼저 저장돼도 중간부터 재생 가능하다고 표시하지 않는다.

부분 스냅샷은 별도 계약으로 ID·원래 시각·요청 일치·빈 문안·겹침 경계·해시·진행 revision을 검증한다. B에는 부분 상태와 번역 완료 시각을 저장하고 기존 A는 보존한다. 팝업은 첫 구간이 수신되면 **처음부터 B로 재생**을 활성화한다. 사용자가 누를 때만 0초로 이동해 재생하며, 번역 도착 자체가 재생·탐색을 일으키지 않는다. 준비된 범위를 넘어가면 영어 원문을 표시하고 팝업/작업실에 다음 구간 번역 중임을 안내한다. 후속 분할은 설정·재생 위치를 유지하며 B를 늘린다.

전편 저장 후 `finalize_translation`은 기존 전체 응답 검증기를 통과해야 한다. 그때만 완성된 응답 JSON과 B VTT를 확정하고 부분 B를 전편 B로 교체한다. 모든 문안이 저장돼도 이 호출 전에는 완료로 보고하지 않는다. 새로고침/서버 재시작 후 부분 번역을 이어받고, 같은 revision/해시는 중복 적용하지 않는다. 오래된 진행이나 줄어드는 범위는 덮어쓰지 않으며 확정 결과를 부분 결과로 되돌리지 않는다.

회차가 바뀌면 부분·전체 결과 모두 원래 회차의 IndexedDB에 보관하고 다른 회차 화면에 적용하지 않는다. 원문/선택 작업이 바뀐 결과는 보관 기록에 남긴다. 탭 전달 실패 후에도 저장 결과는 유지하고 재연결 때 적용한다. 수동 B 파일을 선택한 작업에서는 이후 자동 B 교체를 중단한다.

## 저장과 접근 범위

개인 자막·요청·결과·맥락·서버 로그·연결 토큰은 Git에서 제외된 `private-subtitles/bridge/`에 저장한다. 임의 경로 읽기·셸 실행·영상 다운로드 도구는 없다. MCP HTTP 엔드포인트는 루프백 Host와 Origin을 검사한다. 확장 API는 허용된 확장의 Origin·헤더로 페어링한 뒤 별도 토큰을 요구한다. Chrome이 Origin을 생략하는 GET은 이미 페어링한 유효 토큰과 작업실 헤더가 모두 있을 때만 허용한다. Origin이 다른 웹사이트는 유효 토큰을 보내더라도 거부하며 최초 페어링과 쓰기 요청은 허용된 Origin이 필수다. 확장 토큰은 `chrome.storage.local`에만 보관한다.

페어링·작업 생성 POST는 팝업 확장 페이지에서 실행하고 백그라운드는 GET만 수행한다. 준비·수신 등록 메시지는 동일 확장의 팝업 URL에서만 허용한다. 추가 권한 `clipboardWrite`는 사용자가 누른 번역 프롬프트 복사, `alarms`는 백그라운드 수신 재개에 사용한다. 클립보드 읽기·ChatGPT 콘텐츠 스크립트·ChatGPT 도메인 추가 권한은 없다.

로컬 합성 검사는 실제 일반 ChatGPT 왕복이나 실제 시청 증거와 구분한다. 현재 회차별 실제 연결·반환·표시 상태는 개인 인계 기록에 남긴다.

## 연결 시간 초과 점검과 2026-10-24 복구

먼저 `/healthz`와 직접 localhost MCP 호출로 브리지 응답을 확인하고, 공식 클라이언트의 `runtimes status ottspeed --json` 및 해당 런타임 로그를 검사한다. 서버와 런타임이 모두 중지돼 있던 사례가 있었다. 프로세스가 종료된 이유는 확인되지 않았다. 기존 `jobs`·수집 보관소를 지우거나 재생성하지 않고 같은 저장소로 서버를 재시작한다. 터널 재연결은 승인되어 보관된 키가 있으면 `connect-translation-tunnel.ps1 -UseSavedKey`를 사용한다.

공식 클라이언트가 `.yaml` 프로필 안에 JSON을 저장하는 경우가 있어 YAML 정규식만으로는 `control_plane.organization_id`를 추가하지 못했다. 연결 스크립트는 이제 연결 명령에 조직을 명시하고 JSON/YAML 형식을 구분해 조직 설정을 보존한다. 터널 ID·조직·상위 MCP 주소를 대조하고, 최종 성공은 연결된 앱의 실제 `get_translation_job`·`read_subtitle_chunk` 반환으로 판단한다.

2026-10-24 복구 후 현재 대화의 연결된 OTTSpeed 앱 → Secure MCP Tunnel → 로컬 MCP 경로에서 전체 8개 작업, 기존 E03, E07 단건, E07 첫 150개 원문 조회에 실제 성공했다. 직접 localhost 조회 성공과 별도 기록이다. 사용자가 이전에 열어 둔 ChatGPT 대화 화면에서 재실행한 결과는 아직 없다. E07→E08→E09→E10→E11 순서의 묶음과 복사 프롬프트를 준비했으며 이 복구 검사에서 번역을 실행하지 않았다.

런타임은 실행·healthy·ready 상태지만 독립 `runtimes status`의 원격 메타데이터 조회는 조직 관련 403을 계속 표시한다. 같은 키에 명시적 조직 헤더를 붙인 공식 터널 메타데이터 조회와 실제 앱 호출은 성공했다. 로그의 `server/discover` 400 경고 뒤에도 표준 초기화와 도구 호출이 성공했다. 따라서 상태 명령의 경고가 모두 해소됐다고 보고하지 않는다. 개인 상세 기록은 `private-subtitles/bridge/mcp-recovery-20261024/RESULT.md`에 보관한다.

후속 재확인에서 같은 터널 ID인데 브리지·런타임이 다시 중지된 것을 확인했다. Codex에서 시작한 프로세스가 앱 종료와 함께 종료됐을 가능성이 있지만 OS 종료 원인은 확정하지 않았다. Windows 감독 작업으로 실행 경로를 분리한 뒤 두 전용 서비스를 한 번 중지하는 복구 시험을 수행했다. 약 17초 안에 모두 자동 재시작됐고 실제 연결된 앱 경유 목록·E03·E07·E07 첫 원문 150개 조회가 재성공했다. 감독 프로세스의 부모는 Windows `svchost.exe`이며 실제 Codex 앱 종료·재시작 시험은 아직 수행하지 않았다. 후속 증거는 같은 개인 폴더의 `recheck-*` 파일에 보존한다.
