# OTTDeck 이름 변경과 기존 연결 보존

표시명·저장소명 변경은 데이터 마이그레이션이 아니다. OTTDeck 1.2.0은 이전 OTTSpeed의 확장 저장소와 MCP 작업을 그대로 사용한다.

| 유지하는 값 | 이유 |
|---|---|
| 현재 설치 폴더와 Chrome 확장 ID | IndexedDB·권한·페어링·네이티브 호스트 허용 출처가 같은 설치를 참조 |
| IndexedDB `ottspeed-subtitles`, `sessions`, 버전 1 | 원문/A/B·기존 버전·시간/글자 설정 유지 |
| `speed`, `ottspeedBridge`, `ottspeedTranslation`, `ottspeedLibrary` 등 기존 storage 키 | 환경 설정·페어링·수신 진행 유지 |
| `ottspeed.*` JSON kind와 schemaVersion | 기존 요청 해시·백업·캡처·응답의 계약 유지 |
| `netflix:<videoId>` mediaKey, 요청/작업 UUID·원문 해시 | 현재 GPT가 읽고 쓰는 회차별 작업 유지 |
| `X-OTTSpeed-Client: workspace`, pair client `OTTSpeed` | 실행 중인 구 버전 브리지와 호환 |
| `com.ottspeed.runtime` | 등록된 Chrome Native Messaging 호스트 유지 |
| `OTTSpeed-Translation-Stack`, runtime alias `ottspeed` | 이미 실행 중인 Windows 작업·터널 런타임 유지 |
| 현재 개인 터널·조직·키·루프백 포트 | ChatGPT 앱의 연결 대상 유지. 계정별 값은 개인 프로필에서 조회 |
| 기존 `OTT*` 전역 API와 CLI import 경로 | 현재 스크립트·호스트 실행·검사와 호환 |

기존 ChatGPT 앱의 표시명 OTTSpeed도 현재 번역이 끝날 때까지 유지한다. 제품 UI의 OTTDeck 이름과 다른 계층의 연결 식별자다. 작업 파일을 이름 변경에 맞춰 다시 생성하거나 요청 해시를 수정하지 않는다.

## 기존 설치 업데이트

진행 중인 번역은 현재 서버에서 계속한다. 배포 빌드는 기존 `dist/OTTSpeed-1.1.0`을 삭제하거나 덮어쓰지 않는다. 새 패키지는 `dist/OTTDeck-1.2.0`에 준비한다.

번역이 끝난 뒤 새 패키지의 **내용을 기존 설치 폴더에 갱신하고 같은 확장을 새로고침**한다. 새 경로를 별도 확장으로 로드하거나 기존 확장을 제거하지 않는다. Chrome의 경로 기반 개발용 ID가 달라지면 저장소도 달라질 수 있다. 기존 root 경로가 `E:\Projects\OTTSpeed`라면 현재 실행 서비스의 경로로 유지해도 제품명과 저장소명은 OTTDeck을 사용할 수 있다.

`scripts/translation-bridge-store.mjs`, `translation-batch-store.mjs`, `subtitle-library-archive.mjs`와 서버 CLI는 기존 import/실행 진입점이다. 실제 구현을 기능 모듈로 옮겨도 기존 경로로 같은 클래스·함수를 제공한다. 서버는 새 `OTTDECK_*` 환경변수와 기존 `OTTSPEED_*` 설정을 함께 받는다.

프로젝트 표시명은 Codex UI에서 OTTDeck으로 바꾸고 소스 폴더는 유지한다. 터널과 키를 새로 만들거나 GPT 연결을 재등록할 필요는 없다.
