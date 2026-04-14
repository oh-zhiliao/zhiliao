import os
import pytest
from config import MemoConfig, load_config


def test_load_config_from_env(monkeypatch):
    monkeypatch.setenv("MEMO_LLM_BASE_URL", "https://api.deepseek.com/v1")
    monkeypatch.setenv("MEMO_LLM_MODEL", "deepseek-chat")
    monkeypatch.setenv("MEMO_LLM_API_KEY", "sk-test-key")
    monkeypatch.setenv("MEMO_EMBEDDING_BASE_URL", "https://api.deepseek.com/v1")
    monkeypatch.setenv("MEMO_EMBEDDING_MODEL", "deepseek-embedding")
    monkeypatch.setenv("MEMO_DATA_DIR", "/tmp/memo-test")

    config = load_config()
    assert config.llm_base_url == "https://api.deepseek.com/v1"
    assert config.llm_model == "deepseek-chat"
    assert config.llm_api_key == "sk-test-key"
    assert config.embedding_base_url == "https://api.deepseek.com/v1"
    assert config.embedding_model == "deepseek-embedding"
    assert config.data_dir == "/tmp/memo-test"


def test_load_config_defaults(monkeypatch):
    monkeypatch.setenv("MEMO_LLM_API_KEY", "sk-test")
    # Clear any other env vars
    for key in ["MEMO_LLM_BASE_URL", "MEMO_LLM_MODEL", "MEMO_EMBEDDING_BASE_URL",
                "MEMO_EMBEDDING_MODEL", "MEMO_DATA_DIR"]:
        monkeypatch.delenv(key, raising=False)

    config = load_config()
    assert config.llm_base_url == "https://api.deepseek.com/v1"
    assert config.llm_model == "deepseek-chat"
    assert config.data_dir == "/app/data"


def test_load_config_missing_api_key(monkeypatch):
    monkeypatch.delenv("MEMO_LLM_API_KEY", raising=False)
    with pytest.raises(ValueError, match="MEMO_LLM_API_KEY"):
        load_config()
