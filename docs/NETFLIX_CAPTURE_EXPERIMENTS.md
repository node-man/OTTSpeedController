# 실제 Netflix 수집 조건 확인 — 2026-10-24

**후속 로그인 시험에서 E03·E04 headless 전편 확보에 성공했다.** [인증된 headless 결과와 검사 근거](HEADLESS_CAPTURE.md)를 최신 상태로 우선한다. 아래는 15:47 KST까지 빈 프로필로 수행한 초기 실패와 그때의 한계를 보존한 기록이다. 일반 Chrome 비활성 탭 수집은 여전히 미검증이다.

## 관찰 결과

| 조건 | 실제로 실행·관찰한 것 | 결과와 한계 |
|---|---|---|
| 기존 로그인된 일반 Chrome · 활성 E04 | 현재 video DOM 읽기. `visibility=visible`, `paused=false`, `readyState=4`, 최초 `currentTime=2121.411748`, 후속 `2540.320328`, `duration=2610.941666` | 기존 재생·영상 데이터 로드만 확인. 탭 열기·재생·정지·탐색·새로고침 명령 없음. 이 관찰에서 manifest나 자막 파일을 읽지는 않음 |
| 새 비활성 일반 Chrome 탭 | 연결된 도구에 `visible:false`로 회차 탭 생성 요청 | 도구가 `Capability is not available: visibility`를 반환. 이 호출로 비활성 회차 로드를 실행하지 못함. Netflix가 비활성 탭 로드를 막는다는 증거가 아님 |
| Headless Chrome 155.0.8059.85 · 빈 프로필 · EP3 | 설치된 Chrome의 `--headless --dump-dom --screenshot`, 사용자 프로필/쿠키 없이 실제 `/watch/70262107` 접속 | 15:46:58–15:47:04 KST 실행에서 실제 Netflix **NSES-404** 화면. HTML 80,700바이트, video 요소 없음. 새 전체 자막 파일 없음 |
| 같은 headless 실행 방식 · 다른 빈 프로필 · 로그인 페이지 | 실제 `/login` 접속. 입력·로그인 제출 없음 | 15:47:14–15:47:21 KST 실행에서 Netflix 로그인 폼 있음. HTML 684,705바이트. Headless에서 Netflix 페이지 렌더링 자체는 가능 |

EP3 빈 프로필 시험은 첫 실행 15:44:59에도 같은 NSES-404 화면을 남겼다. 최초 진단 스크립트는 Windows Chrome launcher가 종료된 직후 아직 쓰이는 stdout을 읽다가 실패했다. 이때 실제 Chrome 출력 HTML·PNG는 생성됐고 테스트 프로세스는 이후 종료됐다. 스크립트를 완전한 HTML/PNG를 기다리도록 고친 뒤 위 15:46 시험에서 정상적으로 보고서를 저장했다. 최초 스크립트 오류도 Netflix 수집 실패 원인으로 혼동하지 않는다.

## 초기 빈 프로필 시험에서 내릴 수 있던 결론

- Headless Chrome이 이 PC에서 실행되고 Netflix 페이지를 렌더링하는 것은 실제로 확인했다.
- 빈 프로필 EP3의 NSES-404 원인은 이번 자료만으로 확정할 수 없다. 로그인 여부·회차 접근 조건·headless 여부가 통제된 비교가 아니므로 headless 차단 또는 인증 문제 하나로 단정하지 않는다.
- 이 초기 시험에서는 로그인된 headless 세션의 회차 manifest·영어 트랙·전체 자막 바이트 수신이 미검증이었다. 빈 프로필은 기존 로그인 상태를 자동으로 공유하지 않는다. 사용자 쿠키·프로필을 추출/복제해 채우지 않았다. 이후 전용 프로필의 정상 로그인으로 조건을 충족한 결과는 위 후속 기록에 있다.
- 새 비활성 탭의 최초 로드도 미검증이다. 기존 활성 탭의 `readyState=4`를 새 비활성 탭 로드 성공으로 확대하지 않는다.
- 과거 EP4 별도 탭의 M7020도 동시 사용이라는 다른 조건을 포함한다. 비활성 탭 자체가 불가능하다는 증거로 쓰지 않는다.
- 일반 Chrome 수집 대기열은 UI에 **실험·실제 미검증**으로 표시한다. 실제 파일 확보 후 독립 검사까지 통과하기 전에는 지원 완료라고 표시하지 않는다.

## 재현 도구·자료

`scripts/probe-netflix-headless.ps1`은 매번 새로운 개인 테스트 디렉터리를 만들고 설치된 Chrome만 실행한다. 기존 시청 프로필/쿠키·OTTSpeed 확장을 사용하지 않는 페이지 접근 시험이다. 계정 로그인이나 자막 수집 성공 여부를 대신 검사하는 도구가 아니다.

```powershell
.\scripts\probe-netflix-headless.ps1 -Target watch -VideoId 70262107
.\scripts\probe-netflix-headless.ps1 -Target login
```

개인 자료는 `private-subtitles/headless-probes/`에 보존한다.

- `20261024-154658-f3e66a8f10de441bb7eaf822ee6f09ed/report.json`, `document.html`, `headless.png`: EP3 접근 NSES-404.
- `20261024-154714-b3f629e1761c4bffa6274bcf8f692947/report.json`, `document.html`, `headless.png`: 로그인 폼 접근.
- `20261024-154459-550064bb5b98464cbc3f221ff2f778b3/`: 첫 실행 출력·오류 로그. 최초 스크립트 실패 후 생성된 실제 화면을 별도로 확인함.
- `existing-viewing-tab-observation.json`: 후속 E04 재생 DOM 관찰, 기존 플레이어 조작 명령 없음.

Chrome의 일반적인 headless 지원은 [공식 문서](https://developer.chrome.com/docs/automation-and-testing/headless)에 설명돼 있다. 그 지원을 Netflix의 인증된 자막 확보 지원으로 해석하지 않는다.
