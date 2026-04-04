import os

OPS_DB_URL: str = os.getenv("OPS_DB_URL", "postgresql://ops:password@172.17.0.1:5434/ops")
PORT: int = int(os.getenv("PORT", "9000"))
DEFAULT_MODEL: str = os.getenv("DEFAULT_MODEL", "claude-sonnet-4-6")
OPENCLAW_GATEWAY_URL: str = os.getenv("OPENCLAW_GATEWAY_URL", "http://172.17.0.1:18789")
OPENCLAW_GATEWAY_TOKEN: str | None = os.getenv("OPENCLAW_GATEWAY_TOKEN")
OPENCLAW_HOOKS_TOKEN: str | None = os.getenv("OPENCLAW_HOOKS_TOKEN")
DEPLOY_ORCHESTRATOR_URL: str = os.getenv("DEPLOY_ORCHESTRATOR_URL", "http://172.17.0.1:18791")
ORCHESTRATOR_TOKEN: str | None = os.getenv("ORCHESTRATOR_TOKEN")
ANTHROPIC_API_KEY: str | None = os.getenv("ANTHROPIC_API_KEY")
OPENAI_BASE_URL: str | None = os.getenv("OPENAI_BASE_URL")
OPENAI_API_KEY: str | None = os.getenv("OPENAI_API_KEY")
OPENAI_MODEL: str = os.getenv("OPENAI_MODEL", "glm-4")
CODE_TASK_ENABLED: bool = os.getenv("CODE_TASK_ENABLED", "true").lower() == "true"
