# claude-sub

기존 `claude` 명령의 로그인·플러그인·대화 기록을 공유하면서 `claude-sub`에서
Sonnet(기존 로그인 또는 Anthropic API)·DeepSeek·Kimi·MiniMax M3/M3.1 Flash·OpenRouter GPT를 선택하는 **TypeScript 로컬 라우터**입니다.
Python이나 로컬 인증 토큰은 필요하지 않습니다.

## 실행 구조와 지원 환경

배포 대상은 **일반 Ubuntu, WSL2 Ubuntu, Vast.ai 같은 Linux Docker 컨테이너**입니다. 기본 설치는
호스트의 Node.js에서 라우터를 직접 실행합니다. Rust 구현이나 Rust 바이너리가 아닙니다.

```text
claude-sub → 로컬 라우터(Node.js / systemd 또는 백그라운드 프로세스) → Provider API
claude     → 기존 Claude Code 인증 환경
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
Sonnet은 기존 Claude Code 로그인 또는 Anthropic API 키로 사용할 수 있으며,
API 키를 쓰는 경우 Pro/Max 구독 가입은 필요하지 않습니다.
일반 Ubuntu에서는 일반 사용자 계정으로 설치하며 `sudo`는 사용하지 않습니다.
Vast.ai 같은 root 컨테이너에서는 해당 root 계정으로 설치할 수 있습니다.

```bash
cd claude-sub-router
cp envs/.env.example envs/keys.env
chmod 600 envs/keys.env   # 여러종류의 키가 있을 시 chmod 600 envs/*.env
nano envs/keys.env
bash install.sh
source ./env.bash
claude-sub
```

`envs/.env.example`에 `MOONSHOT_API_KEY`, `DEEPSEEK_API_KEY`, `MINIMAX_API_KEY`,
`OPENROUTER_API_KEY`, 선택 항목인 `ANTHROPIC_API_KEY` 칸이 있습니다.
MiniMax M3와 M3.1 Flash는 `config/providers/minimax.yaml`로 등록되어 있으며 실제 호출에는
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
claude-sub -p "짧게 인사해줘" --model sonnet
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

서드파티 Provider 키는 서버에서만 읽으며 `.bashrc`에 전역 export하지 않습니다.
Anthropic 키는 Claude Code의 인증 선택을 위해 `claude-sub` 자식 프로세스에도 전달합니다.
키 파일이 없거나 비어 있어도 서버는 시작합니다. 서드파티 모델은 해당 Provider
키가 없으면 호출에 실패하며, Sonnet은 프로젝트 Anthropic 키가 없으면 기존
Claude Code 인증을 사용합니다.
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

### Sonnet 로그인과 Anthropic API 키

`config/providers/antropic.yaml`의 `auth: claude_native`는 Claude Code가 선택한
인증을 공식 Anthropic API에 전달합니다. 선택 항목인 `ANTHROPIC_API_KEY`를 기존
`envs/*.env` 파일에 추가하면 구독 플랜 없이도 Sonnet을 호출할 수 있습니다.
`--env-file`로 설치했다면 런처도 그 파일만 읽습니다. 환경변수·파일 우선순위와
빈 값·중복 검사 규칙은 다른 Provider 키와 같습니다.

기존 설치에 API 키를 추가할 때는 사용 중인 키 파일을 열어
`ANTHROPIC_API_KEY` 항목을 한 번만 추가하세요. `.env.example`을 기존 파일에
덮어쓸 필요는 없습니다. `--env-file`로 설치했다면 지정한 파일을 수정하세요.
키를 저장한 뒤 프로젝트 디렉터리에서 다음 순서로 확인합니다.

```bash
npm run build
claude-sub-router restart
claude-sub --check
claude-sub -p "짧게 인사해줘" --model sonnet
```

`--check`의 `anthropic_auth.api_key_configured`가 `true`, `print`가 `api_key`이면
Sonnet의 `-p` 호출에 API 키를 전달합니다. `api_key_source`가 `provider_env_file`이면
프로젝트 키 파일에서, `inherited_environment`이면 실행한 셸 환경에서 가져온 키입니다.
키를 추가한 뒤에는 실행 중인 대화형 세션도 새로 시작하세요.

| 실행 | 프로젝트 Anthropic 키 있음 | 프로젝트 키 없음 또는 빈 값 |
| --- | --- | --- |
| `claude-sub -p`의 Sonnet(기본 모델·`sonnet`·등록 ID) | API 키 사용 | Claude Code의 기존 인증 선택 |
| 대화형 `claude-sub`의 Sonnet | Claude Code의 키 승인·거절 정책 적용 | Claude Code의 기존 인증 선택 |
| `claude`, `claude -p` | 기존 Claude Code 설정·셸 환경에 따름 | 기존 Claude Code 설정·셸 환경에 따름 |

대화형에서는 Claude Code가 키 사용을 한 번 확인하고 선택을 기억합니다.
설치된 버전의 `/config`에서 “Use custom API key”를 변경하고 `/status`에서 실제
인증을 확인할 수 있습니다. `-p`는 키가 있으면 승인 창 없이 API를 사용합니다.
이 동작은 [Claude Code 공식 인증 우선순위](https://code.claude.com/docs/en/authentication#authentication-precedence)를 계승합니다.
라우터는 요청에 담긴 API 키 또는 Bearer 인증을 전달하며, 서버에 키가 있다는
이유로 구독 요청을 API로 바꾸지 않습니다. 잘못된 키·잔액 부족 등 API 오류가 나도
구독 인증으로 자동 전환하지 않습니다. `ANTHROPIC_API_KEY`와 기존
`CLAUDE_CODE_OAUTH_TOKEN`은 해당 자식 프로세스에만 전달하며 프로필·사용자 설정에
키를 저장하지 않습니다. `subagents.yaml`의 모델 정책은 그대로 적용됩니다.

키 파일은 `source`하거나 전역 `export`하지 마세요. 직접 셸에
`ANTHROPIC_API_KEY`를 export하면 일반 `claude`도 Claude Code의 원래 규칙에 따라
그 키를 보게 됩니다. 프로젝트 파일만 수정하면 일반 `claude`에는 전달되지 않습니다.
`claude-sub --check`의 `anthropic_auth`에는 키 설정 여부와 모드 정책만 표시하며
키 값은 표시하지 않습니다.

### 기능별 모델 지정

`config/subagents.yaml`에서 세 기능의 모델을 독립적으로 선택합니다. 서브에이전트와 압축은
`inherit`, Ouroboros 인터뷰·명확화는 `claude-sonnet-5-5`가 기본값입니다.
`inherit`를 선택한 항목은 Claude와 플러그인의 기존 모델 선택 규칙·환경변수를 유지합니다.
메인 연결의 기본 Sonnet을 다른 기능의 공통 기본값으로 지정하지 않습니다.
원하는 항목의 `model`만 **등록 모델 ID**로 바꾸세요. 등록 모델과 필요한 키 이름은
`config/providers/*.yaml`에서 확인할 수 있습니다.

```yaml
subagents:
  model: inherit
  force: false
compaction:
  model: inherit
ouroboros:
  model: claude-sonnet-5-5
```

| 항목 | 적용 범위 | 모델을 선택했을 때 |
| --- | --- | --- |
| `subagents` | 일반 서브에이전트·Explore/Plan | Claude의 서브 모델 환경변수 설정 |
| `compaction` | 자동 압축·`/compact`의 요약 요청 | 공식 `compaction` 요청 헤더를 보고 해당 요청만 라우팅 |
| `ouroboros` | Ouroboros의 인터뷰·명확화 기본 모델, Claude Code backend | `OUROBOROS_CLARIFICATION_MODEL`과 `OUROBOROS_PIN_MODELS=1` 설정 |

예를 들어 `subagents.model: gpt-6.1-sol`, `subagents.force: true`로 설정하면 메인 모델과
압축·Ouroboros 설정을 유지하면서 일반 서브에이전트를 GPT로 보냅니다.
파일 수정 후 **새 `claude-sub` 실행부터** 적용됩니다. 확장 기능을 처음 설치할 때는
`npm run build`와 `claude-sub-router restart`가 필요하며, 이후 이 YAML만 변경할 때는
라우터 재시작이 필요하지 않습니다. `claude-sub --check`의 `model_policy`로 확인하세요.
파일이 없는 이전 설치와 기존 최상위 `model`/`force` 형식도 지원합니다.
기존 형식과 새 섹션을 한 파일에서 함께 사용하면 오류로 처리합니다.

| 목적 | Claude Code 공식 설정 | 이 프로젝트의 설정 위치 |
| --- | --- | --- |
| 새 세션 기본 모델 | `ANTHROPIC_DEFAULT_MODEL` | `config/providers/*.yaml`의 `default: true` |
| 현재 메인 모델 | `--model`, `/model`, `ANTHROPIC_MODEL`, `model` | 기본값은 위 YAML, 실행별 변경은 `--model` |
| 서브에이전트 기본 모델 | `CLAUDE_CODE_SUBAGENT_MODEL` | `config/subagents.yaml`의 `subagents.model` |
| 서브 모델 강제 적용 | `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` | 같은 파일의 `subagents.force: true` |
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

압축 모델을 선택하면 Claude Code **2.1.273 이상**을 확인하고
`CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`을 켭니다. 실행별 선택값은 로컬 라우터에서만
소비하는 헤더로 전달하므로 다른 세션의 압축 모델에 영향을 주지 않습니다.
요청 종류 헤더가 없으면 요청의 원래 모델을 유지하며 프롬프트 내용으로 추측하지 않습니다.
압축 모델을 지정했는데 실행 중인 서버가 이전 버전이면, 모델을 무시하는 대신 재시작을 안내합니다.
[공식 gateway hint headers](https://code.claude.com/docs/en/llm-gateway-protocol#gateway-hint-headers).

Ouroboros의 실행 worker·평가 모델·개별 역할 설정은 플러그인에서 관리합니다.
`ouroboros.model`을 선택하면 플러그인 전체의 모델 자동 최신 해석을 끄는 pin 기능도 켭니다.
개별 역할 모델의 우선순위는 플러그인 규칙을 따릅니다. `inherit`에서는 두 변수를 덮어쓰지 않습니다.
Ouroboros 0.59.5에서 Sonnet 5.5 API 키를 사용한 인터뷰·명확화 생성을 확인했습니다.

Ouroboros의 `inherit`는 메인 Sonnet 모델을 그대로 상속한다는 뜻이 아닙니다.
플러그인이 `opus` 등 라우터에 등록되지 않은 모델을 선택하면 `400 Unknown model`로
실패하므로 인터뷰 모델을 등록 ID로 명시합니다. API 키 사용 시 표시되는 claude.ai
connectors 비활성 경고만으로 인증 실패를 판단하지 마세요. 실제 응답 오류를 확인하세요.

Claude Code 업데이트 후 Ouroboros가 실행 파일을 찾지 못하면, Ouroboros의
`orchestrator.cli_path`가 `command -v claude`의 현재 경로를 가리키는지 확인하세요.
한 번의 실행에만 지정하려면 `OUROBOROS_CLI_PATH="$(command -v claude)" claude-sub`를 사용합니다.

YAML의 덮어쓰기는 `claude-sub` 자식 프로세스에만 적용합니다.
원본 `claude`의 설정 파일이나 전역 셸은 수정하지 않습니다.
별도 파일을 실행 한 번에만 선택하려면 다음처럼 사용합니다.

```bash
CLAUDE_SUB_SUBAGENT_CONFIG=/path/to/subagents.yaml claude-sub --check
CLAUDE_SUB_SUBAGENT_CONFIG=/path/to/subagents.yaml claude-sub
```

잘못된 YAML, 등록되지 않은 모델 ID, 누락된 명시적 파일 경로는 실행 전에 거부합니다.
키 누락이나 Provider 오류를 다른 모델로 자동 대체하지 않습니다.
모델 선택과 해당 모델의 Artifact 도구·압축·플러그인 호환성은 별도 검증 대상입니다.

## 모델 설정

`config/providers/*.yaml`이 모델 목록·기본 모델·인증·reasoning 매핑의 원본입니다.
`default: true`는 한 모델에만 지정합니다. `upstream_model`에는 Provider가 받는
실제 모델 ID를 사용합니다. 기본값은 Sonnet 5.5이며 기존 로그인 또는 Anthropic API 키를
사용합니다. 서드파티 모델은 해당 Provider의 API 키 인증을 사용합니다.
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
    none: { action: disable }
    low: low
    medium: high
    high: high
    xhigh: high
    max: max
  unsupported_level: error
```

공통 추론 강도는 GPT-6 Luna를 기준으로 `none`, `low`, `medium`, `high`, `xhigh`,
`max`의 6단계입니다. `mode: map`은 이 여섯 키를 모두 명시해야 합니다.
기존 5단계 사용자 프리셋에는 `none` 정책을 추가해야 하며, `max`도 필수입니다.
실행 중인 구버전 라우터는 새 매핑을 처리하지 못하므로 재시작이 필요합니다.
런처는 서버의 `reasoning-six-levels` 기능을 검사해 구버전 서버 재사용을 거부합니다.
Provider의 실제 단계가 적으면 위 예시처럼 여러 공통 단계를 같은 값으로 매핑합니다.
알 수 없는 공통 단계, `null` 매핑, 잘못된 action은 거부합니다.

| 매핑 값 | upstream 처리 |
| --- | --- |
| 문자열 (`none`, `low`, `high` 등) | `output_config.effort`를 해당 값으로 변환 |
| `{ action: disable }` | effort를 제거하고 `thinking`을 `{ type: disabled }`로 교체. `none`에만 사용 |
| `{ action: omit }` | effort만 제거하고 기존 `thinking`은 보존 |
| `{ action: error }` | 해당 모델의 지원 불가 요청으로 HTTP 400 반환 |

`none`은 추론 끄기를 뜻하며 effort 생략과 다릅니다. 생략하면 Provider의 기본값이
적용될 수 있습니다. `thinking.type: disabled` 입력도 `none`으로 정규화하며,
이때 함께 남아 있는 이전 `high`·`max` 값보다 끄기 의도를 우선합니다.
effort와 끄기 신호가 모두 없으면 Provider 기본 동작을 보존합니다.
`disable`은 기존 thinking 예산·표시 옵션까지 제거해 모순된 설정을 보내지 않습니다.
메시지의 과거 thinking 블록·서명, 도구, 구조화 출력 형식은 보존하고,
effort 제거 후 빈 `output_config`는 전달하지 않습니다.
메시지 생성과 토큰 계산 요청에 같은 변환·지원 여부 검사를 적용합니다.

Claude Code 자체의 `/effort`·`--effort`는 여전히 `low`부터 `max`까지 5단계입니다.
이 YAML은 Claude Code의 내장 선택기를 확장하지 않습니다. 추론을 끄려면
Linux/Windows의 `Alt+T`, macOS의 `Option+T`로 thinking을 끄세요. 라우터는
전달된 `thinking.type: disabled`를 해당 모델의 `none` 정책으로 처리합니다.
API 클라이언트는 `output_config: { effort: none }`을 직접 보낼 수도 있습니다.
[Claude Code 모델 설정](https://code.claude.com/docs/en/model-config),
[Kimi의 Claude Code 추론 제어 안내](https://www.kimi.com/code/docs/en/third-party-tools/claude-code.html).

기존 `mode: observe`는 입력을 그대로 전달하고, 단계 제어가 없는 Provider에 쓰는
`mode: omit`는 모든 effort를 제거하면서 `thinking`을 보존합니다. 단계 조절 불가와
추론 끄기 지원 여부가 서로 다르면 M3처럼 6단계 표에서 각 action을 지정하세요.

| 모델 | `none` | `low` | `medium` | `high` | `xhigh` | `max` |
| --- | --- | --- | --- | --- | --- | --- |
| GPT-6 Luna | `none` | `low` | `medium` | `high` | `xhigh` | `max` |
| GPT-6.1 Sol | HTTP 400 | `low` | `medium` | `high` | `xhigh` | `max` |
| Sonnet 5.5 | HTTP 400 | `low` | `medium` | `high` | `xhigh` | `max` |
| DeepSeek Pro / Flash | thinking 끄기 | `low` | `high` | `high` | `high` | `max` |
| Kimi K3 | thinking 끄기¹ | `low` | `high` | `high` | `max` | `max` |
| MiniMax M3 | thinking 끄기 | effort 제거 | effort 제거 | effort 제거 | effort 제거 | effort 제거 |
| MiniMax M3.1 Flash | HTTP 400 | `low` | `medium` | `high` | `xhigh` | `max` |

¹ Kimi Coding은 thinking을 끄면 Provider 내부에서 K2.8 Preview의 비추론 모드로
처리합니다. 라우터가 `upstream_model`을 바꾸는 것은 아닙니다.
Sonnet 5.5의 `between_tools`는 도구 사이 thinking을 남기므로 완전한 `none`으로
취급하지 않으며, 클라이언트가 명시하면 그대로 보존합니다.
[DeepSeek 추론 제어](https://api-docs.deepseek.com/guides/thinking_mode/),
[Kimi 모델별 effort·끄기 정책](https://www.kimi.com/code/docs/en/kimi-code/models.html),
[Sonnet 5.5 thinking 변경 사항](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide).

`context.window`와 `context.auto_compact_threshold`는 모델별로 지정합니다.
서드파티의 현재 자동 압축 설정은 800,000토큰이며 Sonnet에는 이를 강제하지 않습니다.
설정이 실제 Provider의 최대 컨텍스트를 늘리는 것은 아닙니다.
Claude Code의 최대 컨텍스트 환경변수는 안전을 위해 등록된 서드파티 모델의
`context.window` 중 최솟값을 공통 상한으로 사용합니다(현재 900,000토큰).
자동 압축 설정은 각 모델의 `auto_compact_threshold`에서 별도로 생성합니다.

### Kimi Code와 DeepSeek Flash 연결 점검

Kimi의 `MOONSHOT_API_KEY`는 기존 변수명이며, 값은 반드시
[Kimi Code Console](https://www.kimi.com/code/console)의 **구독용 API 키**여야 합니다.
Moonshot/Kimi Open Platform 키는 Kimi Code와 호환되지 않습니다. 기본 주소는
`https://api.kimi.com/coding/`이며 해외 계정용 공식 주소는
`https://api.kimi.ai/coding/`입니다. 계정에 맞게 `config/providers/kimi.yaml`에서 변경하세요.

`kimi-k3`는 `k3`를 호출합니다. Plus/Moderato는 K3 256K, Pro/Allegretto 이상은
K3 1M을 지원합니다. Plus/Moderato에서는 `context.window`를 `262144`,
`auto_compact_threshold`를 그보다 작은 값(예: `200000`)으로 설정하세요.
K3 권한이 없는 기존 Andante 요금제는 `upstream_model: kimi-for-coding`이 필요합니다.
현재 기본 Kimi 설정은 K3 1M 권한이 있는 요금제를 전제로 합니다.
[공식 모델·주소·요금제 안내](https://www.kimi.com/code/docs/en/kimi-code/models.html),
[인증·권한·사용량 오류 안내](https://www.kimi.com/code/docs/en/kimi-code/error-reference.html).

DeepSeek V4.1 Flash 1017의 공식 호출 ID는 **`deepseek-flash`**입니다.
`deepseek-v4.1-flash-1017` 같은 버전명을 임의로 보내지 않습니다.
기존 `deepseek-flash` 항목으로 최신 모델을 사용할 수 있습니다.
[DeepSeek 공식 호출 ID 안내](https://api-docs.deepseek.com/).

Claude Code의 대화형 세션에서는 `Artifact` 도구의 `pattern: "^[^\\0]*$"`를
DeepSeek 스키마 검증기가 거부할 수 있습니다. 라우터는 DeepSeek Flash/Pro로 보낼 때
도구 입력 스키마의 NUL 이스케이프 `\0`를 같은 의미의 `\u0000`으로 자동 변환합니다.
중첩 스키마와 토큰 계산·압축 요청에도 적용합니다. 메시지·예제·상수의 문자열과
다른 Provider로 보내는 스키마는 그대로 보존합니다.

`unknown variant tool_definition, expected tool_reference`라는 HTTP 422 오류는
Claude Code가 메시지 안에서 추가한 도구 정의를 DeepSeek가 지원하지 않을 때 발생합니다.
라우터는 해당 정의를 지연 로딩 도구로 선언하고, 원래 메시지에는 도구 이름 참조를
전달해 추가·제거 시점을 유지합니다. 같은 이름의 도구를 재정의하면 최신 정의를
사용합니다. 이 변환도 DeepSeek 요청에만 적용하며 기존 대화 기록 파일은 수정하지 않습니다.

Kimi는 `tool_definition`뿐 아니라 메시지 안의 `tool_addition` 이름 참조도 거부합니다.
라우터는 Kimi 요청의 추가·제거 기록을 처리해 **현재 로드된 도구만** 일반 `tools`
목록으로 전달합니다. Claude Code의 `ToolSearch`와 MCP 검색·호출은 계속 동작하며,
검색되지 않은 지연 로딩 도구는 미리 전달하지 않습니다. `ENABLE_TOOL_SEARCH=false` 설정은
필요하지 않습니다. 검색 결과의 `tool_reference`도 해당 도구 선언과 텍스트 결과로 변환합니다.
새 도구를 로드하면 `tools` 목록이 바뀌므로 Provider의 프롬프트 캐시가
다시 계산될 수 있습니다. 이 변환은 요청에만 적용하며 사용자 설정과 대화 기록은 보존합니다.

설정을 바꾼 뒤에는 다음 명령으로 실행 중인 라우터에도 반영하세요.
`Router models differ from YAML`은 재시작 전 모델 목록이 남아 있다는 뜻입니다.

```bash
npm run build
claude-sub-router restart
claude-sub --model kimi-k3 -p 'Reply with exactly OK.' --effort low
claude-sub --model deepseek-flash -p 'Reply with exactly OK.' --effort low
```

### MiniMax M3와 M3.1 Flash

신규 `minimax-m3.1-flash`는 공식 API의 **`MiniMax-M3.1-Flash`**로 연결합니다.
컨텍스트는 1,000,000토큰, 자동 압축은 800,000토큰입니다.
Claude Code에서 선택한 `low`, `medium`, `high`, `xhigh`, `max`를
Provider의 같은 단계로 자동 매핑합니다. 실행할 때 `--effort`를 따로 지정할 필요는 없습니다.
API 요청에 effort 자체가 없으면 Provider 기본값 `max`가 적용됩니다.
이 모델은 추론이 필수이므로 thinking 끄기 또는 `none`은 로컬에서 HTTP 400으로 거부합니다.

```bash
claude-sub --model minimax-m3.1-flash
```

`minimax-m3`는 공식 API의 `MiniMax-M3`로 연결합니다. 컨텍스트는 공식 문서의
1,000,000토큰을 사용하며, 자동 압축 800,000토큰은 **이 프로젝트의 운영 정책**이지
MiniMax가 제시한 별도 권장값은 아닙니다.

M3의 추론 제어는 `thinking`으로 보존합니다. 공식 Anthropic 호환 문서는 단계형
`output_config.effort` 조절을 **M3.1 Flash 전용**으로 명시하므로 M3에
존재하지 않는 low/high 매핑을 만들지 않습니다. 6단계 표에서 `none`은
`action: disable`, 나머지 단계는 `action: omit`로 지정합니다. 따라서 M3에서는
추론을 켜고 끌 수 있지만 `/effort`로 단계별 추론 깊이가 조절되지는 않습니다.
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

GPT-6 Luna의 공식 6단계를 공통 기준으로 사용합니다. Luna는 `none`까지 동일값으로
매핑하고, Sol은 추론이 필수이므로 `none: { action: error }`로 명시합니다.
두 모델의 나머지 다섯 단계는 동일값으로 매핑합니다. Anthropic 요청의
`output_config.effort`를 매핑하고 OpenRouter가 대상 모델의 reasoning 형식으로 변환합니다.
[OpenAI GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna),
[OpenAI GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[공개 모델 메타데이터](https://openrouter.ai/api/v1/models),
[reasoning 옵션 문서](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens),
[Anthropic Messages API](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-messages).

Claude Code가 보내는 비호출용 deferred placeholder는 OpenRouter 요청에서만 제거합니다.
실제 도구와 ToolSearch는 유지하므로 도구 검색을 끄지 않고 최초 호출의 HTTP 400을 방지합니다.

공유할 추가 Claude 설정은 `config/claude-settings.json`에 넣습니다.
기존 로컬 `config/claude-test.json`이 있으면 이를 우선 사용하며 Git에는 포함하지 않습니다.
모델 선택 목록은 실행할 때 생성하므로 별도 Python 동기화 명령은 필요하지 않습니다.

## 개발 및 테스트

```bash
npm ci --include=dev --ignore-scripts
npm run check
npm test
npm run build
npm run test:auth
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

`test:auth`는 설치된 Claude CLI를 임시 프로필·가짜 Anthropic 서버로 실행합니다.
`-p`의 API 키 사용, 부모 환경 유지, 빈 키에서 OAuth 계승, 인증 오류에서
OAuth로 자동 전환하지 않는 동작을 확인하며 실제 비용은 발생하지 않습니다.

실제 CLI 연결 테스트는 **구독 한도/API 비용을 사용**합니다. 설치·로그인·키 설정 후 실행하세요.

```bash
npm run test:cli
node scripts/test-cli.mjs deepseek-flash
```

원본 `claude -p`와 `claude-sub -p`를 도구·MCP·세션 저장 없이 짧게 호출합니다.
기본 실행은 원본 Sonnet 및 라우터의 모든 모델을 검사하며, 모델 인수는 해당
`claude-sub` 모델만 검사합니다. 응답 본문·키를 제외한 요약만
`artifacts/cli-e2e.json`에 저장합니다. 이 디렉터리는 배포하지 않습니다.

도구 검색을 켠 실제 MCP 흐름도 별도로 검증할 수 있습니다(API 비용 사용).

```bash
npm run build
npm run test:tool-search -- kimi-k3 deepseek-flash
```

이 테스트는 임시 로컬 MCP 서버와 `ENABLE_TOOL_SEARCH=true`를 사용합니다.
`ToolSearch`로 도구를 검색하고 실제로 호출한 뒤, 서버가 반환한 무작위 토큰으로 최종
응답하는지 확인합니다. 검색하지 않은 도구가 upstream에 로드되거나 중간에 HTTP 400/422가
발생하면 실패합니다. 따라서 CLI의 자동 재시도로 오류가 가려진 경우도 통과하지 않습니다.
요약은 `artifacts/tool-search-e2e.json`에 저장합니다.

Anthropic 인증을 실제 서비스까지 확인하려면 키 소유자가 기존 키 파일에
`ANTHROPIC_API_KEY`를 직접 추가한 뒤 아래 테스트를 실행합니다. 이미 키가 설정되어
있다면 추가 입력은 필요하지 않습니다. 키 값을 채팅이나
공개 로그에 붙여 넣지 마세요.

```bash
claude-sub-router restart
npm run test:cli -- --anthropic-auth
```

이 테스트는 기존 인증의 `claude -p --model sonnet`을 한 번, API 방식의
`claude-sub -p`를 명시 모델 ID·`sonnet` 별칭·모델 인수 생략으로 각각 한 번
호출합니다. 라우터 로그의 인증 종류(`api_key`)와 HTTP 200도 검증합니다.
키가 없으면 호출 전에 중단합니다. 실제 구독 한도/API 비용을 사용합니다.
대화형은 `claude-sub`에서 키 승인·거절과 `/status`를 직접 확인하세요.

실제 **서브에이전트 호출** 검증도 API 비용을 사용하며 CI에서는 자동 실행하지 않습니다.

```bash
npm run test:subagents
npm run test:subagents -- kimi-k3 minimax-m3
npm run test:subagents -- --policies-only
SUBAGENT_TEST_MAIN_MODEL=gpt-6.1-sol npm run test:subagents
```

테스트 메인은 기본 `deepseek-flash`이며 프로젝트의 Sonnet 기본값은 변경하지 않습니다.
각 실행에 세 정책 섹션이 있는 임시 YAML을 지정하여 기본 실행은 Sonnet을 포함한
등록 모델 8종을 모두 검사합니다.
충돌하는 `model: sonnet` 에이전트 정의를 강제로 덮어쓰고, 하위 Agent가 임시 파일의
무작위 문자열을 **Read 도구로 읽고 반환**했는지 검사합니다. 부모의 파일 읽기는 실패로
처리합니다. 스트림의 `parent_tool_use_id`, 하위 응답의 실제 모델, 라우터의 Provider
요청·HTTP 200과 해당 Agent 호출에 연결된 결과 전달도 확인하므로 부모의 성공 주장만으로는
통과하지 않습니다. 인수 없이 실행하면 메인 모델 상속, 기본값/정의 우선순위와 내장 Explore
강제 적용도 추가 검증합니다. `--policies-only`는 이 네 정책 사례만 실행합니다.
결과는 `artifacts/subagents-e2e.json`에 저장합니다. Claude가 출력한 비용은 추정치이며
특히 `costBasis: unknown`인 커스텀 모델에서는 Provider의 실제 청구액과 다를 수 있습니다.

### 최근 검증 결과

2026-10-21에 Claude Code **2.1.305**, Node.js **24.15.0**, Linux/WSL2에서 확인했습니다.
비대화형은 실제 Read 도구로 임의 토큰 파일을 읽고 반환하는 시나리오,
대화형은 실제 PTY에서 Read·응답·키보드 후속 입력·응답·정상 종료하는 시나리오입니다.
서브에이전트는 임시 YAML의 모델 선택과 실제 자식 모델·Read·부모에게 결과 전달을 확인했습니다.

| 모델 ID | `claude-sub -p` | 대화형 `claude-sub` | 서브에이전트 모델 지정 |
| --- | --- | --- | --- |
| `claude-sonnet-5-5` | 통과 | 통과 | 통과 |
| `deepseek-pro` | 통과 | 통과 | 통과 |
| `deepseek-flash` | 통과 | 통과 | 통과 |
| `kimi-k3` | 통과 | 통과 | 통과 |
| `minimax-m3.1-flash` | 통과 | 통과 | 통과 |
| `minimax-m3` | 통과 | 통과 | 통과 |
| `gpt-6.1-sol` | 통과 | 통과 | 통과 |
| `gpt-6-luna` | 통과 | 통과 | 통과 |

Sonnet은 명시 ID·`sonnet` 별칭·모델 생략 기본값과 실제 대화형 모두 API 키 인증·HTTP 200을
확인했습니다. 원본 `claude -p --model sonnet`도 기존 로그인으로 성공했습니다.
자동 검사 **60/60**, 오프라인 CLI 인증 검사, 타입 검사와 빌드가 통과했습니다.

YAML 정책은 상속·기본값·에이전트 정의 우선·내장 Explore 강제 적용의 실제 4사례와
3개 기능 × 8개 모델의 설정 전달 24조합을 확인했습니다. 실제 `/compact`는 Sonnet 대화에서
DeepSeek Flash로 압축한 뒤 Sonnet으로 후속 응답하는 사례가 통과했습니다.
ToolSearch→MCP 호출은 Kimi K3·DeepSeek 2종·GPT 2종에서 통과했습니다.

표는 수정 후 최종 시나리오 결과입니다. 초기 GPT 호출의 placeholder 관련 HTTP 400을
수정하고 해당 모델을 재검증했으며, 대화형 시험의 입력 처리와 지시도 정리했습니다.
24조합은 설정 전달 검사이며 기능별 실제 LLM 호출 24회를 뜻하지 않습니다.
Ouroboros는 모델 설정 전달까지 확인했고 별도 LLM 실행은 포함하지 않았습니다.
모든 플러그인·effort 조합·장시간 안정성은 이번 검증 범위에 포함하지 않았습니다.

### 벤치마크

```bash
npm run benchmark
```

벤치마크는 로컬 `/health`의 기동·응답 시간만 측정하며 LLM의 추론 속도를 뜻하지 않습니다.
전환 시 동일 장비의 5회 중앙값은 Python 171 ms → TypeScript 55.17 ms였습니다.
현재 벤치마크는 TypeScript만 측정합니다. 이전 Python 비교용 분기와 가상환경은 제거했습니다.

## Git 및 배포

소스 저장소에 보관하는 파일과 실행 환경에 배포하는 파일은 구분합니다.

| 경로 | Git 관리 | 용도 및 배포 정책 |
| --- | --- | --- |
| `.github/workflows/` | 포함 | CI와 GitHub Release 자동화 설정. 런타임 배포 파일과 Docker 빌드 컨텍스트에서는 제외 |
| `src/`, `config/providers/`, `scripts/`, `tests/`, 패키지·설치 설정 | 포함 | 소스·공유 설정·빌드·검증에 필요. 런타임에 필요한 파일만 배포 허용 목록에 포함 |
| `.serena/`, `.claude/`, `.claude-sub/`, `.codex/`, `.agents/` | 제외 | 로컬 개발 도구의 설정·캐시·작업 데이터 |
| `temp/` | 제외 | PC 이식용 대화 기록과 로컬 인수인계 패키지 |
| `node_modules/`, `dist/`, `artifacts/`, `coverage/` | 제외 | 의존성과 생성 결과. 배포 압축 파일은 GitHub Release 자산으로 게시 |
| 실제 `.env`·`envs/` 키 파일 | 제외 | 각 실행 환경에서 별도 관리. 값이 비어 있는 `envs/.env.example`만 공유 |

Serena의 `project.yml`은 팀 설정으로 공유할 수도 있지만, 이 프로젝트에서는 `.serena/`
전체를 로컬 도구 설정으로 취급합니다. 빌드·CI·라우터 실행에는 사용하지 않습니다.
`.gitignore`는 Git 추가 대상을, `.dockerignore`는 Docker 빌드 컨텍스트를 제어하며,
배포 압축 파일의 내용은 `scripts/package-release.mjs`의 허용 목록으로 별도 관리합니다.

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
현재 워크플로에는 Vast.ai 서버를 자동으로 갱신하거나 재시작하는 배포 단계는 없습니다.

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
