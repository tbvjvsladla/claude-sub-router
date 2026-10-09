# claude-sub

기존 `claude` 명령의 로그인·플러그인·대화 기록을 공유하면서 `claude-sub`에서
구독 Sonnet·DeepSeek·Kimi·MiniMax M3·OpenRouter GPT를 선택하는 **TypeScript 로컬 라우터**입니다.
Python이나 로컬 인증 토큰은 필요하지 않습니다.

## 실행 구조와 지원 환경

배포 대상은 **일반 Ubuntu, WSL2 Ubuntu, Vast.ai 같은 Linux Docker 컨테이너**입니다. 기본 설치는
호스트의 Node.js에서 라우터를 직접 실행합니다. Rust 구현이나 Rust 바이너리가 아닙니다.

```text
claude-sub → 로컬 라우터(Node.js / systemd 또는 백그라운드 프로세스) → Provider API
claude     → 기존 Claude Code 구독 환경
```

`.bashrc`는 명령을 찾기 위한 PATH만 등록합니다. 사용자 systemd가 동작하면 기존처럼
systemd 서비스를 설치하고, 사용할 수 없으면 `standalone` 방식으로 실행합니다.
root 컨테이너는 자동으로 `standalone`을 선택합니다. 셸을 열 때마다 서버를 새로 띄우지 않습니다.
systemd 설치는 사용자 로그인 시, WSL에서는 배포판과 사용자 세션이 실행되는 동안 동작합니다.
라우터는 LLM 자체를 호스팅하지 않고 외부 API로 요청을 전달합니다.

WSL2에서 systemd 방식을 사용하려면 설치 전
`systemctl --user list-units --no-pager`가 성공해야 합니다. systemd가 꺼진 WSL2는
`/etc/wsl.conf`에 `[boot]` 아래 `systemd=true`를 추가하고 Windows에서
`wsl.exe --shutdown` 후 다시 실행하세요. 기존 설정을 덮어쓰지 마세요.
systemd 서비스만으로 WSL 인스턴스가 계속 살아 있는 것은 아닙니다.
[Microsoft의 WSL systemd 안내](https://learn.microsoft.com/en-us/windows/wsl/systemd)를 참고하세요.

## 설치

Node.js **22.18.0 이상**, npm, bash, 설치된 Claude Code가 필요합니다.
일반 Ubuntu에서는 일반 사용자 계정으로 설치하며 `sudo`는 사용하지 않습니다.
Vast.ai 같은 root 컨테이너에서는 해당 root 계정으로 설치할 수 있습니다.

```bash
cd claude-router
cp envs/.env.example envs/keys.env
chmod 600 envs/keys.env
nano envs/keys.env
bash install.sh
source ./env.bash
claude-sub
```

`envs/.env.example`에 `MOONSHOT_API_KEY`, `DEEPSEEK_API_KEY`, `MINIMAX_API_KEY`,
`OPENROUTER_API_KEY` 칸이 있습니다.
MiniMax M3는 `config/providers/minimax.yaml`로 등록되어 있으며 실제 호출에는
`MINIMAX_API_KEY`가 필요합니다. 기존 키 파일을 쓰는 경우 그 파일에 키를 추가하세요.

기존 사용자는 키 파일을 다시 만들 필요가 없습니다. 기본 설치는 `envs/*.env`를 모두
자동으로 읽으며, 기존 `CHINA_provider.env`, `USA_provider.env` 같은 이름도 지원합니다.
키 파일이 하나도 없으면 기존 루트 `.env`를 사용하고, 그것도 없을 때만 예제를
`envs/keys.env`로 복사합니다(권한 `600`). 기존 파일을 덮어쓰지 않습니다.
이전 단일 파일 서비스에서 자동 검색으로 전환하려면 `bash install.sh`를 한 번 다시 실행하세요.
자동 검색 대신 특정 파일만 사용하도록 지정할 수도 있습니다.

```bash
bash install.sh --env-file "$HOME/.config/claude-providers/keys.env"
```

### 키 파일 구성

한 파일에 모든 키를 넣어도 되고, 관리하기 편하게 여러 파일로 나누어도 됩니다.

```text
envs/
├── .env.example    # 공개되는 빈 예제; 읽지 않음
├── CHINA.env       # 개인 키; 자동 로딩; Git 제외
└── USA.env         # 개인 키; 자동 로딩; Git 제외
```

파일명이나 국가명은 모델 연결에 영향을 주지 않습니다. `config/providers/*.yaml`의
`provider.api_key_env`와 변수 이름이 일치해야 합니다. 예를 들어 `DEEPSEEK_API_KEY`는
DeepSeek 모델, `MOONSHOT_API_KEY`는 Kimi 모델에서 참조합니다. 키를 추가하는 것만으로
새 모델이 등록되지는 않습니다. Meta 등 다른 Provider도 지원하려면 별도 YAML과
현재 라우터가 지원하는 Anthropic 호환 API가 필요합니다.

- 시작할 때 `envs/` 바로 아래의 `*.env` 파일을 파일명 순서로 읽습니다. 하위 폴더,
  `.env.example`, `.bak` 파일은 읽지 않으며 심볼릭 링크는 거부합니다.
- 같은 키에 서로 다른 값이 있으면 시작·재설치를 거부하고 변수명과 파일 경로만 알립니다.
  동일한 값의 중복은 허용하고 빈 값은 무시합니다. 파일 순서로 키를 덮어쓰지 않습니다.
- 외부에서 이미 설정한 비어 있지 않은 환경변수가 파일 값보다 우선합니다.
  다만 파일 간 충돌은 환경변수가 있더라도 수정해야 합니다.
- YAML에 등록된 `api_key_env`만 불러옵니다. dotenv 형식의 리터럴 값을 쓰세요.
  `export KEY=value`는 허용하지만 `${VARIABLE}` 치환이나 셸 명령 실행은 하지 않습니다.
- 키 파일을 추가·수정한 뒤 `claude-sub-router restart`로 반영합니다.
  `chmod 600 envs/*.env`로 키 파일 접근 권한을 제한하세요.

설치기는 의존성 설치·컴파일, 두 명령 등록, `.bashrc` 관리 블록 등록과 라우터 즉시 기동을
처리합니다. systemd 방식은 사용자 서비스의 로그인 자동 시작도 등록합니다.
변경되는 기존 파일은 타임스탬프 `.bak`로 백업합니다. 재부팅은 필요하지 않습니다.
수동 라우터가 실행 중이면 먼저 종료하세요. 설치 폴더를 옮기면 재설치해야 합니다.
재설치는 서버를 재시작하므로 진행 중인 요청이 없을 때 실행하세요.

### Vast.ai 등 systemd 없는 컨테이너

```bash
cd /workspace/claude-sub-router
bash install.sh --service standalone
source ./env.bash
claude-sub-router status
claude-sub
```

`--service auto`가 기본값이며 `systemd`와 `standalone`을 명시할 수도 있습니다.
원본 Claude의 같은 사용자 프로필(root라면 `/root/.claude`)을 공유합니다.
`source ./env.bash`는 Vast.ai의 자동 tmux 진입 등 기존 `.bashrc` 동작을 다시 실행하지 않고
현재 셸에 명령 경로만 추가합니다. 추가 Supervisor나 tmux 설정은 필요하지 않습니다.

`standalone` 라우터는 터미널에서 분리되어 SSH 접속을 끊어도 유지됩니다.
`start/restart/stop/status/logs` 명령은 두 방식에서 동일하게 사용할 수 있습니다.
상태·로그·설치 정보는 `~/.local/state/claude-sub-router/`에 저장하며, 다른 프로그램이나
수동으로 실행한 서버를 자동으로 종료하지 않습니다.
컨테이너 재시작 또는 라우터 종료 후에는 `claude-sub` 실행 시 다시 시작합니다.
로그인 시 자동 시작이나 비정상 종료 직후의 자동 재시작은 systemd 방식에서 지원합니다.
standalone 로그는 `router.log`에 누적되며 `logs`는 최근 100줄(최대 64KiB)을 표시합니다.
컨테이너 자체가 종료되면 라우터도 종료됩니다.

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
수동 실행과 systemd 실행 모두 Node의 dotenv 파서를 사용하며 키 파일을 셸로 실행하지 않습니다.

`claude-sub`는 원본 `claude`와 같은 프로필(기본 **`~/.claude`**)을 사용합니다.
구독 로그인, 설치된 플러그인·스킬·MCP, hooks, 대시보드(`statusLine`), 대화 기록을
그대로 읽으므로 같은 세션을 두 명령에서 이어갈 수 있습니다.

```bash
claude-sub --resume SESSION_ID
claude --resume SESSION_ID
```

런처는 `CLAUDE_CONFIG_DIR`을 강제로 지정하지 않습니다. 셸에서 이 변수를
명시했다면 두 명령 모두 그 프로필을 사용합니다. 라우터 주소와 모델 설정은
자식 프로세스의 환경변수와 `--settings`로 해당 실행에만 적용하며 사용자 설정 파일에
저장하지 않습니다.
공유 프로필에서 `/config`나 `/model`로 저장한 사용자 설정은 두 명령에 공통 적용됩니다.

이전 버전의 `~/.claude-sub`는 삭제하거나 심볼릭 링크로 교체하지 않습니다.
그 안의 기존 대화를 별도로 열려면 `CLAUDE_CONFIG_DIR="$HOME/.claude-sub" claude --resume <ID>`를
사용할 수 있습니다. 프로필 폴더 전체를 덮어쓰지 마세요.
설정 경로와 실행별 덮어쓰기 동작은
[공식 환경변수 문서](https://code.claude.com/docs/en/env-vars)와
[공식 설정 문서](https://code.claude.com/docs/en/settings#change-a-setting-for-one-session)를 따릅니다.

### 서브에이전트 모델 지정

메인/default 모델과 서브에이전트 모델은 별도로 지정할 수 있습니다.
`config/subagents.yaml`에서 원하는 **등록 모델 ID**와 강제 적용 여부를 설정하세요.
파일 주석에 현재 서드파티 모델 6종과 필요한 키 이름이 있습니다.

```yaml
model: gpt-6.1-sol
force: true
```

이 예제는 메인을 기존 `claude-sonnet-5-5`로 유지하면서 서브에이전트를 GPT로 보냅니다.
파일 수정 후 **새 `claude-sub` 실행부터** 적용되며 라우터 재시작은 필요하지 않습니다.
`claude-sub --check`의 `default_model`, `subagent_model`, `subagent_force`로 확인하세요.
기본 파일은 `model: inherit`로 기존 에이전트 선택 규칙을 유지합니다.
`inherit`일 때 `force`는 무시하며 두 서브에이전트 환경변수를 지정하지 않습니다.
파일이 없는 이전 설치도 같은 방식으로 동작합니다.

| 목적 | Claude Code 공식 설정 | 이 프로젝트의 설정 위치 |
| --- | --- | --- |
| 새 세션 기본 모델 | `ANTHROPIC_DEFAULT_MODEL` | `config/providers/*.yaml`의 `default: true` |
| 현재 메인 모델 | `--model`, `/model`, `ANTHROPIC_MODEL`, `model` | 기본값은 위 YAML, 실행별 변경은 `--model` |
| 서브에이전트 기본 모델 | `CLAUDE_CODE_SUBAGENT_MODEL` | `config/subagents.yaml`의 `model` |
| 서브 모델 강제 적용 | `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` | 같은 파일의 `force: true` |
| 개별 에이전트 모델 | `.claude/agents/*.md`, `~/.claude/agents/*.md`의 `model`, `--agents` | 기존 에이전트 정의 |
| 모델 별칭 해석 | `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` 등 | 이번 변경에서 지정하지 않음 |

`force: false`에서는 **호출 시 model → 에이전트 정의 model → 서브 기본 모델 → 메인 모델**
순서가 적용됩니다. 정의의 `model: inherit`도 서브 기본값보다 우선하므로,
Explore/Plan 같은 내장 에이전트까지 변경하려면 `force: true`를 사용하세요.
강제 적용에는 Claude Code **2.1.257 이상**이 필요하며 실행 전에 버전을 검사합니다.
강제 적용 중에도 **fork와 `model: inherit`인 서브에이전트 스킬은 메인 모델을 유지**합니다.
관리자 `availableModels` 제한으로 Claude가 다른 모델을 선택할 수도 있으므로
실행 중 `/tasks`의 실제 모델을 확인하세요.
[공식 서브에이전트 모델 우선순위와 강제 적용](https://code.claude.com/docs/en/sub-agents#choose-a-model),
[공식 모델 설정](https://code.claude.com/docs/en/model-config#environment-variables).

YAML은 `claude-sub` 자식 프로세스의 서브에이전트 환경변수를 구성하며 같은 이름의
상속된 셸 변수를 대체합니다. 원본 `claude`의 설정 파일이나 전역 셸은 수정하지 않습니다.
별도 파일을 실행 한 번에만 선택하려면 다음처럼 사용합니다.

```bash
CLAUDE_SUB_SUBAGENT_CONFIG=/path/to/subagents.yaml claude-sub --check
CLAUDE_SUB_SUBAGENT_CONFIG=/path/to/subagents.yaml claude-sub
```

잘못된 YAML, 등록되지 않은 모델 ID, 누락된 명시적 파일 경로는 실행 전에 거부합니다.
키 누락이나 Provider 오류를 다른 모델로 자동 대체하지 않습니다.

## 모델 설정

`config/providers/*.yaml`이 모델 목록·기본 모델·인증·reasoning 매핑의 원본입니다.
`default: true`는 한 모델에만 지정합니다. `upstream_model`에는 Provider가 받는
실제 모델 ID를 사용합니다. 기본값은 구독 Sonnet이며 서드파티는 API 키 인증입니다.
API 키는 기본적으로 `x-api-key` 헤더로 전송합니다. Bearer 인증 게이트웨이는
`provider.api_key_header: authorization`을 지정하면 등록된 Provider 키로
`Authorization: Bearer ...`를 만듭니다. Claude 구독 토큰을 대신 보내지 않습니다.

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
Claude Code의 최대 컨텍스트 환경변수는 안전을 위해 등록된 서드파티 모델의
`context.window` 중 최솟값을 공통 상한으로 사용합니다(현재 900,000토큰).
자동 압축 설정은 각 모델의 `auto_compact_threshold`에서 별도로 생성합니다.

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

### OpenRouter OpenAI

`config/providers/openrouter-openai.yaml`에 두 모델을 등록합니다.

| Claude Code 모델 ID | OpenRouter 모델 ID | 운영 컨텍스트 | 자동 압축 설정 |
| --- | --- | --- | --- |
| `gpt-6.1-sol` | `openai/gpt-6.1-sol` | 900,000 | 800,000 |
| `gpt-6-luna` | `openai/gpt-6-luna` | 900,000 | 800,000 |

`envs/USA.env` 등 자동 검색되는 키 파일에 `OPENROUTER_API_KEY`를 넣으세요.
라우터는 OpenRouter의 Anthropic 호환 `https://openrouter.ai/api/v1/messages`로
등록된 키만 Bearer 인증하여 전송합니다. 원본 `claude` 구독 환경은 변경하지 않습니다.

확인한 로컬 Hermes의 `-900k` 프리셋은 Codex OAuth용 클라이언트 별칭이며,
OpenRouter 모델 ID가 아닙니다. 이 프로젝트에서는 요청한 900k를 **운영 상한**으로
적용하고 upstream에는 `-900k`를 붙이지 않습니다. OpenRouter가 두 모델에 공시한
컨텍스트는 각각 1,050,000토큰입니다. 800k 자동 압축 역시 이 프로젝트의 정책입니다.
[GPT 6.1 Sol](https://openrouter.ai/openai/gpt-6.1-sol),
[GPT 6 Luna](https://openrouter.ai/openai/gpt-6-luna).

2026-10-08 공개 모델 메타데이터에서 두 모델 모두 `low`, `medium`, `high`, `xhigh`,
`max`를 지원하므로 해당 다섯 단계를 각각 동일값으로 명시적으로 매핑합니다.
Sol은 reasoning이 필수이고 Luna는 `none`도 지원하지만, 공통 Claude effort 매핑은
reasoning을 임의로 끄지 않으며 알 수 없는 단계는 거부합니다. Anthropic 요청의
`output_config.effort`를 매핑하고 OpenRouter가 대상 모델의 reasoning 형식으로 변환합니다.
[공개 모델 메타데이터](https://openrouter.ai/api/v1/models),
[reasoning 옵션 문서](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens),
[Anthropic Messages API](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-messages).

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
node dist/cli.js serve
```

수동 실행도 `envs/*.env`를 자동으로 읽습니다. `serve --env-file /path/to/keys.env`는
지정한 파일만 읽으며 자동 검색과 루트 `.env` fallback을 사용하지 않습니다.

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

실제 **서브에이전트 호출** 검증도 API 비용을 사용하며 CI에서는 자동 실행하지 않습니다.

```bash
npm run test:subagents
npm run test:subagents -- kimi-k3 minimax-m3
SUBAGENT_TEST_MAIN_MODEL=gpt-6.1-sol npm run test:subagents
```

테스트 메인은 기본 `deepseek-flash`이며 프로젝트의 Sonnet 기본값은 변경하지 않습니다.
각 실행에 임시 YAML을 지정하여 기본 실행은 서드파티 6종을 모두 검사합니다.
충돌하는 `model: sonnet` 에이전트 정의를 강제로 덮어쓰고, 하위 Agent가 임시 파일의
무작위 문자열을 **Read 도구로 읽고 반환**했는지 검사합니다. 부모의 파일 읽기는 실패로
처리합니다. 스트림의 `parent_tool_use_id`, 하위 응답의 실제 모델, 라우터의 Provider
요청·HTTP 200도 확인하므로 부모의 성공 주장만으로는 통과하지 않습니다.
인수 없이 실행하면 기본값/정의 우선순위와 내장 Explore 강제 적용도 추가 검증합니다.
결과는 `artifacts/subagents-e2e.json`에 저장합니다. Claude가 출력한 비용은 추정치이며
특히 `costBasis: unknown`인 커스텀 모델에서는 Provider의 실제 청구액과 다를 수 있습니다.

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

`envs/.env.example`만 Git과 배포 파일에 포함합니다. 실제 `*.env`, 루트 `.env`,
그 밖의 `envs/` 내용, 사용자 프로필, 개인 설정, 백업, `.venv`, `node_modules`는 제외합니다.
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
docker run --rm --network host --env-file envs/keys.env claude-sub-router
```

Docker 실행은 Claude Code 설치나 구독 로그인을 대신하지 않습니다.

## 삭제

`claude-sub` 세션을 종료한 후 설치 폴더에서 실행하세요. 원본 `claude`는 종료할 필요가 없습니다.

```bash
bash uninstall.sh --dry-run
bash uninstall.sh
hash -r
```

선택한 방식의 라우터를 중지하고 두 명령과 `.bashrc` 관리 블록을 제거합니다.
systemd 방식은 자동 시작과 서비스 파일도 제거합니다. standalone 로그와 설치 정보는 보존합니다.
기존 Python 설치 항목도 인식하며, 수정된 파일이나 다른 경로의 설치는 안전을 위해 거부합니다.
원본 `claude`, 두 프로필의 로그인·설정·대화, 키 파일, 프로젝트와 백업은 삭제하지 않습니다.
재설치하려면 `bash install.sh`를 다시 실행하세요.
