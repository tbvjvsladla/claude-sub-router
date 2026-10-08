# claude-sub

기존 `claude` 명령과 구독 로그인을 유지하면서 별도 `claude-sub` 환경에서
구독 Sonnet·DeepSeek·Kimi·MiniMax M3를 선택하는 **TypeScript 로컬 라우터**입니다.
Python이나 로컬 인증 토큰은 필요하지 않습니다.

## 실행 구조와 지원 환경

배포 대상은 **일반 Ubuntu와 WSL2 Ubuntu**입니다. 기본 설치는 Docker 없이
호스트의 Node.js에서 라우터를 직접 실행합니다. Rust 구현이나 Rust 바이너리가 아닙니다.

```text
claude-sub → 로컬 라우터(Node.js / systemd 사용자 서비스) → Provider API
claude     → 기존 Claude Code 구독 환경
```

`.bashrc`는 명령을 찾기 위한 PATH만 등록하고, systemd가 라우터 시작·재시작·로그를
관리합니다. 셸을 열 때마다 서버를 새로 띄우지 않습니다. 일반 Ubuntu에서는 사용자
로그인 시, WSL에서는 배포판과 사용자 세션이 실행되는 동안 동작합니다.
라우터는 LLM 자체를 호스팅하지 않고 외부 API로 요청을 전달합니다.

WSL2에서도 systemd와 사용자 서비스 관리자가 필요합니다. 설치 전
`systemctl --user list-units --no-pager`가 성공해야 합니다. systemd가 꺼진 WSL2는
`/etc/wsl.conf`에 `[boot]` 아래 `systemd=true`를 추가하고 Windows에서
`wsl.exe --shutdown` 후 다시 실행하세요. 기존 설정을 덮어쓰지 마세요.
systemd 서비스만으로 WSL 인스턴스가 계속 살아 있는 것은 아닙니다.
[Microsoft의 WSL systemd 안내](https://learn.microsoft.com/en-us/windows/wsl/systemd)를 참고하세요.

## 설치

Ubuntu의 일반 사용자 계정, 사용자 systemd, Node.js **22.18.0 이상**, npm,
설치된 Claude Code가 필요합니다. `sudo`는 사용하지 않습니다.

```bash
cd claude-router
cp .env.example .env
chmod 600 .env
nano .env
bash install.sh
source ~/.bashrc
claude-sub
```

`.env.example`에 `MOONSHOT_API_KEY`, `DEEPSEEK_API_KEY`, `MINIMAX_API_KEY` 칸이 있습니다.
MiniMax M3는 `config/providers/minimax.yaml`로 등록되어 있으며 실제 호출에는
`MINIMAX_API_KEY`가 필요합니다. 기존 키 파일을 쓰는 경우 그 파일에 키를 추가하세요.

기존 사용자는 빈 `.env`를 만들 필요가 없습니다. 설치기는 `.env`, 기존
`envs/CHINA_provider.env` 순서로 선택하고, 둘 다 없을 때만 예제 파일을 복사합니다.
다른 키 파일도 지정할 수 있습니다.

```bash
bash install.sh --env-file "$HOME/.config/claude-providers/keys.env"
```

설치기는 의존성 설치·컴파일, 두 명령 등록, `.bashrc` 관리 블록 등록,
사용자 systemd 서비스의 로그인 자동 시작과 즉시 기동을 처리합니다.
변경되는 기존 파일은 타임스탬프 `.bak`로 백업합니다. 재부팅은 필요하지 않습니다.
수동 라우터가 실행 중이면 먼저 종료하세요. 설치 폴더를 옮기면 재설치해야 합니다.
재설치는 서버를 재시작하므로 진행 중인 요청이 없을 때 실행하세요.

## 사용 및 관리

```bash
claude-sub
claude-sub --check
claude-sub --model deepseek-pro
claude-sub-router start
claude-sub-router restart
claude-sub-router status
claude-sub-router logs
claude-sub-router stop
```

`claude-sub`는 작업 디렉터리를 유지하고, 꺼진 서버는 자동으로 시작합니다.
`--check`는 설정만 검사하며 서버를 시작하지 않습니다. `logs`는 최근 100줄을 표시합니다.
YAML이나 키 파일 수정 후에는 라우터를 재시작하고 Claude Code를 새로 시작하세요.

서버는 **`http://127.0.0.1:18765`**에만 바인딩합니다. 다른 프로세스가 포트를
점유하면 종료하거나 임의 재사용하지 않고 실패합니다. 로컬 인증이 없으므로
같은 컴퓨터의 다른 사용자·프로세스도 API 비용을 발생시킬 수 있습니다.
외부에 노출하지 마세요. 자세한 사항은 [SECURITY.md](SECURITY.md)를 참고하세요.

Provider 키는 서버에서만 읽으며 `.bashrc`에 전역 export하지 않습니다.
키 파일이 없거나 비어 있어도 서버는 시작하며 해당 모델 호출만 실패합니다.
잘못된 키는 Provider의 인증 오류를 그대로 반환하고 다른 모델로 대체하지 않습니다.
systemd 실행기는 환경 파일을 Bash로 읽으므로 신뢰하는 파일만 사용하세요.

구독 Sonnet은 **`~/.claude-sub`**의 Claude Code 로그인을 사용합니다.
필요하면 `claude-sub`에서 로그인하세요. 기존 `claude`, `~/.claude`의 로그인·설정은
수정하거나 복사하지 않습니다. 셸에 직접 설정한 Anthropic 환경변수는 별도 영향을 줄 수 있습니다.

## 모델 설정

`config/providers/*.yaml`이 모델 목록·기본 모델·인증·reasoning 매핑의 원본입니다.
`default: true`는 한 모델에만 지정합니다. `upstream_model`에는 Provider가 받는
실제 모델 ID를 사용합니다. 기본값은 구독 Sonnet이며 서드파티는 API 키 인증입니다.

```yaml
reasoning:
  mode: map
  source:
    effort: output_config.effort
    thinking: thinking
  mapping:
    low: low
    medium: high
    high: high
    xhigh: high
    max: max
  unsupported_level: error
```

지원하지 않는 effort나 `null` 매핑은 거부합니다. `observe`는 입력값을 바꾸지 않습니다.
`omit`는 지원되지 않는 `output_config.effort`만 제거하고 `thinking`, 메시지, 도구,
구조화 출력 형식은 보존합니다. 제거 후 빈 `output_config`는 전달하지 않습니다.
`context.window`와 `context.auto_compact_threshold`는 모델별로 지정합니다.
서드파티의 현재 자동 압축 설정은 800,000토큰이며 Sonnet에는 이를 강제하지 않습니다.
설정이 실제 Provider의 최대 컨텍스트를 늘리는 것은 아닙니다.

### MiniMax M3

`minimax-m3`는 공식 API의 `MiniMax-M3`로 연결합니다. 컨텍스트는 공식 문서의
1,000,000토큰을 사용하며, 자동 압축 800,000토큰은 **이 프로젝트의 운영 정책**이지
MiniMax가 제시한 별도 권장값은 아닙니다.

M3의 추론 제어는 `thinking`으로 보존합니다. 공식 Anthropic 호환 문서는 단계형
`output_config.effort` 조절을 **M3.1 Flash Preview 전용**으로 명시하므로 M3에
존재하지 않는 low/high 매핑을 만들지 않고 `reasoning.mode: omit`를 사용합니다.
따라서 M3에서는 `/effort`를 바꿔도 upstream 추론 깊이가 조절된다고 보장하지 않습니다.
M3.1로 모델을 임의 변경하지 않습니다.
[MiniMax 공식 Anthropic API 문서](https://platform.minimax.io/docs/api-reference/text-anthropic-api),
[M3 공식 모델 설명](https://github.com/MiniMax-AI/MiniMax-M3/blob/main/README.md).

공유할 추가 Claude 설정은 `config/claude-settings.json`에 넣습니다.
기존 로컬 `config/claude-test.json`이 있으면 이를 우선 사용하며 Git에는 포함하지 않습니다.
모델 선택 목록은 실행할 때 생성하므로 별도 Python 동기화 명령은 필요하지 않습니다.

## 개발 및 테스트

```bash
npm ci --include=dev --ignore-scripts
npm run check
npm test
npm run build
node dist/cli.js launch --check
node dist/cli.js serve --env-file .env
```

테스트는 임시 디렉터리·가짜 upstream을 사용하고 실제 키나 구독을 소비하지 않습니다.
설치·삭제, 모델 검증, 인증 분리, JSON/SSE, 오류 전달, 취소·스트리밍을 검증합니다.
서버는 Node의 연결 풀을 재사용하며 스트리밍 backpressure와 연결 취소를 처리합니다.
요청 본문 제한은 32 MiB입니다. 개발 서버에 한해 `serve --port 28765`처럼
다른 5자리 포트를 사용할 수 있으며 설치된 명령은 18765를 사용합니다.

실제 CLI 연결 테스트는 **구독 한도/API 비용을 사용**합니다. 설치·로그인·키 설정 후 실행하세요.

```bash
npm run test:cli
node scripts/test-cli.mjs deepseek-flash
```

원본 `claude -p`와 `claude-sub -p`를 도구·MCP·세션 저장 없이 짧게 호출합니다.
기본 실행은 원본 Sonnet 및 라우터의 모든 모델을 검사하며, 모델 인수는 해당
`claude-sub` 모델만 검사합니다. 응답 본문·키를 제외한 요약만
`artifacts/cli-e2e.json`에 저장합니다. 이 디렉터리는 배포하지 않습니다.

```bash
npm run benchmark
```

벤치마크는 로컬 `/health`의 기동·응답 시간만 측정하며 LLM의 추론 속도를 뜻하지 않습니다.
전환 시 동일 장비의 5회 중앙값은 Python 171 ms → TypeScript 55.17 ms였습니다.
현재 벤치마크는 TypeScript만 측정합니다. 이전 Python 비교용 분기와 가상환경은 제거했습니다.

## Git 및 배포

```bash
npm run check:secrets
npm run package:release
npm run test:release
```

`.env`, `envs/`, 사용자 프로필, 개인 설정, 백업, `.venv`, `node_modules`는 Git에서 제외합니다.
스캐너는 일반적인 토큰 형태를 검사하지만 모든 비밀정보를 보장하지 않으므로
업로드 전에 staged diff를 직접 확인하세요. 실제 키를 Git에 추가하지 마세요.

배포 파일 `artifacts/claude-sub-router-v0.1.0.tar.gz`와 `SHA256SUMS`는 명시적 허용 목록으로
생성합니다. `test:release`는 별도 임시 폴더에 압축을 풀고 런타임 의존성 설치·서버 기동까지
검증합니다. 소스 저장소의 개인 파일을 통째로 압축하지 않습니다. 배포 압축 파일을 풀고
키 파일을 설정한 뒤 `bash install.sh`를 실행하면 런타임 의존성만 설치합니다.

GitHub Actions는 Node 22/24에서 타입 검사·오프라인 테스트·비밀정보 검사·배포 패키지를
검증합니다. `package.json` 버전과 일치하는 `v0.1.0` 형식의 태그를 올리면 GitHub Release를
생성합니다. 실제 API 테스트는 CI에서 자동 실행하지 않습니다. npm 공개 배포는
`private: true`로 차단하며, 공개 라이선스 정책은 아직 정하지 않았습니다.

### 선택 사항: Docker

Dockerfile은 별도 컨테이너 배포를 원하는 경우의 선택 사항일 뿐입니다.
일반 Ubuntu/WSL2 설치에는 Docker를 설치하거나 실행할 필요가 없고 `install.sh`도
Docker를 사용하지 않습니다. 컨테이너를 원하지 않으면 아래 명령을 실행하지 마세요.
컨테이너에서 loopback을 유지할 때는 host 네트워크를 사용하며, 동시에 설치된
네이티브 라우터가 실행되면 포트가 충돌합니다.

```bash
docker build -t claude-sub-router .
docker run --rm --network host --env-file .env claude-sub-router
```

Docker 실행은 Claude Code 설치나 구독 로그인을 대신하지 않습니다.

## 삭제

`claude-sub` 세션을 종료한 후 설치 폴더에서 실행하세요. 원본 `claude`는 종료할 필요가 없습니다.

```bash
bash uninstall.sh --dry-run
bash uninstall.sh
hash -r
```

서비스 중지·자동 시작 해제, 두 명령·서비스 파일, `.bashrc` 관리 블록만 제거합니다.
기존 Python 설치 항목도 인식하며, 수정된 파일이나 다른 경로의 설치는 안전을 위해 거부합니다.
원본 `claude`, 두 프로필의 로그인·설정·대화, 키 파일, 프로젝트와 백업은 삭제하지 않습니다.
재설치하려면 `bash install.sh`를 다시 실행하세요.
