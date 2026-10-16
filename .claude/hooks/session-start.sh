#!/bin/bash
# 云端会话启动：装好 Codex CLI，并指向 sacredcraft 网关。
# 密钥不进仓库：在云环境设置里添加环境变量 SACRED_API_KEY，新会话自动生效。
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

if ! command -v codex >/dev/null 2>&1; then
  npm install -g @openai/codex
fi

mkdir -p "$HOME/.codex"
cat > "$HOME/.codex/config.toml" <<'TOML'
model_provider = "sacredcraft"
model = "gpt-6.1-sol"

[model_providers.sacredcraft]
name = "SacredCraft"
base_url = "https://ai.sacredcraft.cn/v1"
env_key = "SACRED_API_KEY"
wire_api = "responses"
TOML
chmod 600 "$HOME/.codex/config.toml"

if [ -z "${SACRED_API_KEY:-}" ]; then
  echo "codex 已安装，但环境变量 SACRED_API_KEY 未设置：请在云环境设置里添加后开新会话。" >&2
else
  echo "codex $(codex --version) 已就绪（gpt-6.1-sol / gpt-6-astra 可用；非交互调用务必加 </dev/null，否则会卡在等 stdin）。"
fi
