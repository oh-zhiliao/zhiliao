import pytest

from config import load_config


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


def test_load_config_decay_days(monkeypatch):
    monkeypatch.setenv("MEMO_LLM_API_KEY", "sk-test")
    monkeypatch.setenv("MEMO_DECAY_AFTER_DAYS", "7")
    for key in ["MEMO_LLM_BASE_URL", "MEMO_LLM_MODEL", "MEMO_EMBEDDING_BASE_URL",
                "MEMO_EMBEDDING_MODEL", "MEMO_DATA_DIR"]:
        monkeypatch.delenv(key, raising=False)

    config = load_config()
    assert config.decay_after_days == 7


def test_load_config_custom_path(monkeypatch, tmp_path):
    # Point MEMO_CONFIG_PATH to a nonexistent file so YAML silently fails
    monkeypatch.setenv("MEMO_CONFIG_PATH", str(tmp_path / "nonexistent.yaml"))
    monkeypatch.setenv("MEMO_LLM_API_KEY", "sk-test")
    monkeypatch.setenv("MEMO_LLM_BASE_URL", "https://custom.api.com/v1")
    monkeypatch.setenv("MEMO_LLM_MODEL", "custom-model")
    monkeypatch.setenv("MEMO_EMBEDDING_BASE_URL", "https://custom-embed.api.com/v1")
    monkeypatch.setenv("MEMO_EMBEDDING_MODEL", "custom-embed")
    monkeypatch.setenv("MEMO_DATA_DIR", "/tmp/custom-data")

    config = load_config()
    assert config.llm_base_url == "https://custom.api.com/v1"
    assert config.llm_model == "custom-model"
    assert config.embedding_base_url == "https://custom-embed.api.com/v1"
    assert config.embedding_model == "custom-embed"
    assert config.data_dir == "/tmp/custom-data"


def test_load_config_separate_embedding_api_key(monkeypatch):
    monkeypatch.setenv("MEMO_LLM_API_KEY", "sk-llm")
    monkeypatch.setenv("MEMO_EMBEDDING_API_KEY", "sk-embed")
    for key in ["MEMO_LLM_BASE_URL", "MEMO_LLM_MODEL", "MEMO_EMBEDDING_BASE_URL",
                "MEMO_EMBEDDING_MODEL", "MEMO_DATA_DIR"]:
        monkeypatch.delenv(key, raising=False)

    config = load_config()
    assert config.llm_api_key == "sk-llm"
    assert config.embedding_api_key == "sk-embed"


def test_load_config_embedding_api_key_defaults_to_llm_key(monkeypatch):
    monkeypatch.setenv("MEMO_LLM_API_KEY", "sk-shared")
    monkeypatch.delenv("MEMO_EMBEDDING_API_KEY", raising=False)
    for key in ["MEMO_LLM_BASE_URL", "MEMO_LLM_MODEL", "MEMO_EMBEDDING_BASE_URL",
                "MEMO_EMBEDDING_MODEL", "MEMO_DATA_DIR"]:
        monkeypatch.delenv(key, raising=False)

    config = load_config()
    assert config.embedding_api_key == "sk-shared"
