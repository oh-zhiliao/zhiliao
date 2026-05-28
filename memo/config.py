import os
from dataclasses import dataclass


@dataclass(frozen=True)
class MemoConfig:
    llm_provider: str
    llm_base_url: str
    llm_model: str
    llm_api_key: str
    embedding_base_url: str
    embedding_model: str
    data_dir: str
    auth_token: str
    embedding_api_key: str = ""
    decay_after_days: int = 30
    llm_timeout: float = 60.0


def _load_yaml_config(path: str = "/app/config.yaml") -> dict:
    """Load config.yaml and return the whole config, or empty dict if unavailable."""
    path = os.environ.get("MEMO_CONFIG_PATH", path)
    try:
        import yaml
        with open(path) as f:
            cfg = yaml.safe_load(f)
        return cfg or {}
    except Exception:
        return {}


def load_config() -> MemoConfig:
    yaml_cfg = _load_yaml_config()
    llm_cfg = yaml_cfg.get("llm", {})
    memo_cfg = llm_cfg.get("memo", {})
    emb_cfg = llm_cfg.get("embedding", {})
    service_cfg = yaml_cfg.get("memo", {})

    api_key = os.environ.get("MEMO_LLM_API_KEY", "") or memo_cfg.get("api_key", "")
    if not api_key:
        raise ValueError("MEMO_LLM_API_KEY env var or llm.memo.api_key in config.yaml is required")
    auth_token = os.environ.get("MEMO_AUTH_TOKEN", "") or service_cfg.get("auth_token", "")
    if not auth_token:
        raise ValueError("MEMO_AUTH_TOKEN env var or memo.auth_token in config.yaml is required")

    llm_base = os.environ.get("MEMO_LLM_BASE_URL", "") or memo_cfg.get("base_url", "https://api.deepseek.com/v1")
    emb_base = os.environ.get("MEMO_EMBEDDING_BASE_URL", "") or emb_cfg.get("base_url", llm_base)
    embedding_api_key = os.environ.get("MEMO_EMBEDDING_API_KEY", "") or emb_cfg.get("api_key", "") or api_key

    return MemoConfig(
        llm_provider=os.environ.get("MEMO_LLM_PROVIDER", "") or memo_cfg.get("provider", "openai_compatible"),
        llm_base_url=llm_base,
        llm_model=os.environ.get("MEMO_LLM_MODEL", "") or memo_cfg.get("model", "deepseek-chat"),
        llm_api_key=api_key,
        embedding_base_url=emb_base,
        embedding_model=os.environ.get("MEMO_EMBEDDING_MODEL", "") or emb_cfg.get("model", "deepseek-embedding"),
        data_dir=os.environ.get("MEMO_DATA_DIR", "/app/data"),
        auth_token=auth_token,
        embedding_api_key=embedding_api_key,
        decay_after_days=int(os.environ.get("MEMO_DECAY_AFTER_DAYS", "30")),
        llm_timeout=float(os.environ.get("MEMO_LLM_TIMEOUT", "60")),
    )
