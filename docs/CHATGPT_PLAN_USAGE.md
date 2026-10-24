# 공식 ChatGPT 요금제 연동 시험

기존 개인 Pro 복사+MCP 경로는 유지한다. 추가 호스트 도구는 OpenAI 공식 Sign in with ChatGPT의 로컬 앱용 ChatGPT plan usage 경로만 사용한다. Workspace Agents, ChatGPT 화면 자동 제출, Chrome 확장 식별은 이 시험에 포함하지 않는다.

공식 근거:

- [로컬 앱용 개요](https://developers.openai.com/siwc/token-sharing-open-source)
- [동적 등록과 로그인](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [모델 목록과 실제 추론](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [현재 제한](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [토큰 갱신과 계정 관리](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)

## 실행

```powershell
npm run chatgpt:login
npm run chatgpt:verify-translation
npm run chatgpt:verify-translation -- --reasoning-mode pro
npm run chatgpt:translate-episode -- --episode S02E06
```

로그인 명령은 `127.0.0.1`의 임시 포트에 `/auth/callback` 리스너와 개인 시작 페이지를 연다. 해당 페이지의 **Continue with ChatGPT**를 사용한다. 사용자 본인이 OpenAI 로그인과 OTTSpeed 권한 동의를 완료해야 한다. 기존 브라우저 쿠키·Codex 자격 증명·API 키를 읽거나 빌려 쓰지 않는다.

최초 등록에는 `dynamic_agent_client`, OTTSpeed 이름, 한 호스트에 고정한 UUID host ID, PKCE S256, 무작위 state·nonce, 공식 scope·resource를 사용한다. 반환된 등록별 client ID, ID 토큰의 서명·발급자·audience·만료·nonce, `chatgpt.tokens.use.direct` 권한을 검사한다. 거부·누락·불일치 시 추론을 실행하지 않는다. 액세스·갱신·ID 토큰은 프로세스 메모리에서 Windows CurrentUser DPAPI로 암호화해 개인 폴더에만 저장한다. 로그와 브라우저 저장소에 토큰을 출력하지 않는다.

다음 실행은 같은 등록 ID와 호스트 ID를 사용한다. 만료가 가까운 토큰은 공식 토큰 endpoint로 직렬 갱신하고 교체된 갱신 토큰을 함께 저장한다. 등록·인증 자료는 Git/확장 패키지에서 제외된 `private-subtitles/chatgpt-plan/`에 둔다.

## 실제 번역 시험 범위

시험은 S02E06의 검증된 영어 원문 전체를 문맥으로 제공하고 **처음 150개 cue 한 조각**을 한국어로 번역한다. 계정의 공식 모델 목록에 `gpt-6.1-sol`이 표시되는지 확인하고 공개 `https://api.openai.com/v1/responses`에 `store:false, stream:true`로 호출한다. 다른 모델·별도 API 과금으로 자동 전환하지 않는다.

문서상 이 경로는 `background`와 서버 측 hosted MCP를 지원하지 않는다. 따라서 호스트 도구가 스트림을 끝까지 읽고 로컬 검증기를 직접 실행한다. 마지막 `response.completed`를 받은 뒤 JSON 구조·150개 ID 전량/순서·빈 문안·한국어 출력·기존 응답 계약·원래 슬롯 시각·VTT 왕복을 검사해야 성공이다. 부분 스트림, HTTP 오류, 실패 이벤트, 완료 이벤트 누락, 검증 실패는 미검증이다.

입력·번역 JSON·부분 B VTT·검사 보고서를 새 시험 폴더에 저장한다. 이는 **한 조각의 실제 호출과 구조 검증**이며 전편 번역·의미 검수 완료를 뜻하지 않는다. 기존 bridge 작업 및 현재 시청 탭에 결과를 자동 적용하지 않는다. 로그인 성공과 실제 번역 성공은 각각 `auth-status.json`, `latest-test.json`으로 구분한다.

향후 무인 순차 번역 실행기는 이 호출을 회차별 대기열·사용량 제한·재개 기록에 연결해야 한다. 이번 시험 성공만으로 전 시즌 무인 번역까지 완성됐다고 주장하지 않는다.

## 한 회 전체 Astra high 실행기

`chatgpt:translate-episode`는 검증한 원문 전체를 한 번 보내 `gpt-6-astra`, `reasoning.effort: high`로 모든 cue를 번역한다. 기본 입력은 S02E06이며 다른 캡처는 `--episode SxxExx --capture <capture.original.json>`으로 지정한다. 호출마다 `episode-runs/` 아래 새 폴더를 만들고 원문 검사, 고정 저장 요청, API 입력, 수신 중인 표시 텍스트, 완료 메타데이터와 실제 토큰을 보존한다. 중단 시 자동 재호출하지 않으므로 중복 사용량을 숨기지 않는다.

전체 응답은 기존 `subtitle-response.mjs`로 검사해 별도 B VTT/SRT를 생성하고 ID·시각·문안의 VTT 왕복을 확인한다. 기존 A/B, bridge 작업, 현재 시청 탭에 자동 적용하지 않는다. 완료 이벤트와 전량 검사 전에는 전편 번역 성공으로 기록하지 않는다. 의미·실제 영상 싱크는 구조 검사와 별개다.

`cost.json`은 반환된 실제 input/output/cache/reasoning 토큰에 [공식 표준 API 단가](https://developers.openai.com/api/docs/pricing)를 적용한 **API 환산액**이다. 추론 토큰은 이미 출력 토큰에 들어 있으므로 이중으로 더하지 않는다. 실행은 기존 SIWC 요금제 연결을 사용하며 API 키는 사용하지 않는다. 구독·연결 크레딧의 실제 차감액은 응답에 없어 `null`로 남긴다. 272,000 초과 입력이나 캐시 쓰기가 있으면 검증되지 않은 단가를 조용히 적용하지 않는다.

2026-10-24 **18:26:42 KST**, S02E06 **2,236/2,236개** 전편 응답 및 기존 B 생성 파이프라인 검증에 성공했다. 요청·반환 모델은 모두 `gpt-6-astra`, 반환 추론 설정은 `effort: high, mode: standard`였다. 한 번 호출했으며 전체 실행 시간은 **511.719초**다. 입력 **56,297**(캐시 56,064, 비캐시 233), 출력 **29,282**(추론 38 포함), 총 **85,579** 토큰을 반환했다. 표준 API 환산액은 **$1.522494**이며 동일 토큰에서 캐시를 제외한 가정은 **$2.027070**이다. 구독 실제 차감액은 알 수 없다.

원본·저장 요청·응답·완료 메타데이터·B VTT/SRT·비용/검사 기록은 개인 `episode-runs/2026-10-24T09-18-10-559Z-11af7bd4-b06d-441a-a994-2c60ae186e23/`에 보존했다. 전편 ID·순서·고정 시각·VTT 왕복은 통과했다. 일부 문안 대조만 수행했으며 전편 의미 검수 및 Netflix 실제 싱크 검증을 완료한 것은 아니다. 현재 시청 탭이나 기존 bridge 결과에 적용하지 않았다.

## 2026-10-24 실제 동의 단계의 미완료 기록

전용 동적 등록 요청을 정상 Chrome에서도 두 번 시험했다. 사용자가 본인 인증을 완료한 뒤 공식 `/sign-in-with-chatgpt/consent` 화면에서 `Operation timed out`을 관측했다. 화면의 재시도로 OTTSpeed 이름 및 ID/ChatGPT 플랜 권한 화면까지 열렸지만, 최종 계속 제출은 자동 클릭·키보드 및 첫 시도의 사용자 직접 클릭에서도 callback으로 돌아오지 않았다. 두 번째 요청은 새 state·nonce·PKCE를 사용했다.

당시에는 로컬에서 수신·검증한 토큰이 없어 모델 호출과 실제 번역을 수행하지 않았다. 이 관측만으로 Pro 자격 미지원, 사용자 패스키 오류, OpenAI 서버 구현 문제 중 하나를 원인으로 확정하지 않는다. 상세 시각과 화면 증거는 개인 `browser-attempts.json` 및 스크린샷에 보존한다. 기존 복사+MCP 흐름은 유지한다.

## 같은 날 실제 연결·번역 성공

이후 사용자가 동일한 새 요청의 공식 시작 URL을 직접 열어 본인 인증·권한 동의를 완료했다. 2026-10-24 **17:48:22 KST**에 OAuth callback이 돌아왔고, 로컬의 ID 토큰 서명·nonce·대상·발급자 및 플랜 사용 scope 검증을 통과했다. 자격 증명은 DPAPI로 암호화 보관했다. 앞선 UI 무반응의 원인은 확정하지 않는다.

계정의 공식 모델 목록 조회에서 `gpt-6.1-sol`을 확인했다. 첫 모델 시험은 HTTP 200의 `Content-Type` 헤더 누락 때문에 로컬 검증기에서 중단됐다. 헤더가 없으면 실제 SSE/JSON 프레이밍과 마지막 `response.completed`를 검사하도록 수정하고 회귀 검사 후 재시도했다. **17:51:09 KST**에 S02E06 앞 **150개 cue**가 실제 한국어로 반환됐고 ID 전량·순서·원래 시각·기존 응답 계약·VTT 왕복이 모두 통과했다.

성공 요청은 영어 2,236개 cue 전체를 문맥으로 전송했다. 서버가 반환한 사용량은 입력 **56,478**, 출력 **2,024** 토큰이다. 실제 원본·요청·반환 JSON·부분 B VTT·완료 ID·검사 보고서를 `private-subtitles/chatgpt-plan/runs/2026-10-24T08-50-11-590Z-c6f750d1-1d99-4262-9915-61e569e513c6/`에 보존했다. 최신 요약은 개인 `VERIFICATION-RESULT.md`와 `latest-test.json`이다. 현재 시청 탭이나 기존 bridge 작업에 결과를 적용하지 않았다.

이는 이 PC·Pro 계정에서 공식 요금제 추론 경로가 실제 동작한 증거다. 전편 번역·전체 의미 검수·전 시즌 무인 실행은 별도다.

## Pro 추론 모드 실제 거절

사용자의 요청에 따라 공식 문서의 `reasoning.mode: "pro"` 설정도 실제 시험했다. 계정 모델 목록에 있는 `gpt-6.1-sol`과 `gpt-6-astra` 모두 HTTP **400**, `unsupported_value`, `param: reasoning.mode`, 메시지 **“`reasoning.mode` is not supported with this model.”**를 반환했다. 이 계정·공식 요금제 연동·시험한 두 모델에서의 결과이며 모든 계정·모델·별도 API 과금 경로의 결과로 확대하지 않는다. 문서상 Pro 모드 존재만으로 이 경로의 지원을 주장하지 않는다.

기본 모드의 실제 150개 번역 성공은 보존했다. 최근 실패 시험이 성공 기록을 숨기지 않도록 `latest-success.json`, 최근 시험 `latest-test.json`, Pro 시험 `latest-pro-test.json`을 구분한다. Pro 요청 거절 시 다른 모델이나 기본 모드로 자동 전환하지 않는다. 성공한 기본 번역 1건과 실패한 Pro 시험들을 `private-subtitles/chatgpt-plan/VERIFICATION-RESULT.md`에서 함께 확인할 수 있다.
