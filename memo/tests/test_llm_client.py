import numpy as np
import openai
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from llm_client import LLMClient


@pytest.fixture
def client():
    return LLMClient(
        llm_base_url="https://api.test.com/v1",
        llm_model="test-chat",
        llm_api_key="sk-test",
        embedding_base_url="https://api.test.com/v1",
        embedding_model="test-embed",
        embedding_api_key="sk-test-embed",
    )


@pytest.mark.asyncio
async def test_summarize(client):
    mock_response = MagicMock()
    mock_response.choices = [MagicMock(message=MagicMock(content="Summary of commits"))]

    with patch.object(client._llm_client.chat.completions, "create", new_callable=AsyncMock, return_value=mock_response):
        result = await client.summarize("Summarize these commits:\n- feat: login\n- fix: password")
        assert result == "Summary of commits"


@pytest.mark.asyncio
async def test_embed(client):
    mock_response = MagicMock()
    mock_response.data = [MagicMock(embedding=[0.1, 0.2, 0.3])]

    with patch.object(client._embed_client.embeddings, "create", new_callable=AsyncMock, return_value=mock_response):
        result = await client.embed("test text")
        assert isinstance(result, np.ndarray)
        assert result.shape == (3,)
        np.testing.assert_array_almost_equal(result, [0.1, 0.2, 0.3])


@pytest.mark.asyncio
async def test_embed_batch(client):
    mock_response = MagicMock()
    # Return out of order to verify sort-by-index
    mock_response.data = [
        MagicMock(embedding=[0.3, 0.4], index=1),
        MagicMock(embedding=[0.1, 0.2], index=0),
    ]

    with patch.object(client._embed_client.embeddings, "create", new_callable=AsyncMock, return_value=mock_response):
        result = await client.embed_batch(["text1", "text2"])
        assert len(result) == 2
        assert result[0].shape == (2,)
        np.testing.assert_array_almost_equal(result[0], [0.1, 0.2])
        np.testing.assert_array_almost_equal(result[1], [0.3, 0.4])


@pytest.mark.asyncio
async def test_embed_batch_empty(client):
    mock_response = MagicMock()
    mock_response.data = []

    with patch.object(client._embed_client.embeddings, "create", new_callable=AsyncMock, return_value=mock_response):
        result = await client.embed_batch([])
        assert result == []


def test_client_has_timeout(client):
    assert client._llm_client.timeout is not None
    assert client._embed_client.timeout is not None
    # Default timeout is 60s
    assert client._llm_client.timeout.read == 60.0
    assert client._llm_client.timeout.connect == 10.0


def test_client_custom_timeout():
    c = LLMClient(
        llm_base_url="https://api.test.com/v1",
        llm_model="test-chat",
        llm_api_key="sk-test",
        embedding_base_url="https://api.test.com/v1",
        embedding_model="test-embed",
        timeout=120.0,
    )
    assert c._llm_client.timeout.read == 120.0
    assert c._embed_client.timeout.read == 120.0


@pytest.mark.asyncio
async def test_summarize_retries_on_timeout(client):
    mock_response = MagicMock()
    mock_response.choices = [MagicMock(message=MagicMock(content="Retried summary"))]

    mock_create = AsyncMock(
        side_effect=[openai.APITimeoutError(request=MagicMock()), mock_response]
    )

    with patch.object(client._llm_client.chat.completions, "create", mock_create), \
         patch("llm_client.asyncio.sleep", new_callable=AsyncMock):
        result = await client.summarize("test prompt")
        assert result == "Retried summary"
        assert mock_create.call_count == 2


@pytest.mark.asyncio
async def test_summarize_retries_on_server_error(client):
    mock_response = MagicMock()
    mock_response.choices = [MagicMock(message=MagicMock(content="Retried summary"))]

    mock_create = AsyncMock(
        side_effect=[
            openai.APIStatusError(
                message="err",
                response=MagicMock(status_code=500),
                body=None,
            ),
            mock_response,
        ]
    )

    with patch.object(client._llm_client.chat.completions, "create", mock_create), \
         patch("llm_client.asyncio.sleep", new_callable=AsyncMock):
        result = await client.summarize("test prompt")
        assert result == "Retried summary"
        assert mock_create.call_count == 2


@pytest.mark.asyncio
async def test_summarize_no_retry_on_client_error(client):
    mock_create = AsyncMock(
        side_effect=openai.APIStatusError(
            message="err",
            response=MagicMock(status_code=400),
            body=None,
        )
    )

    with patch.object(client._llm_client.chat.completions, "create", mock_create), \
         patch("llm_client.asyncio.sleep", new_callable=AsyncMock):
        with pytest.raises(openai.APIStatusError):
            await client.summarize("test prompt")
        assert mock_create.call_count == 1


@pytest.mark.asyncio
async def test_embed_retries_on_timeout(client):
    mock_response = MagicMock()
    mock_response.data = [MagicMock(embedding=[0.1, 0.2, 0.3])]

    mock_create = AsyncMock(
        side_effect=[openai.APITimeoutError(request=MagicMock()), mock_response]
    )

    with patch.object(client._embed_client.embeddings, "create", mock_create), \
         patch("llm_client.asyncio.sleep", new_callable=AsyncMock):
        result = await client.embed("test text")
        assert isinstance(result, np.ndarray)
        np.testing.assert_array_almost_equal(result, [0.1, 0.2, 0.3])
        assert mock_create.call_count == 2


@pytest.mark.asyncio
async def test_embed_batch_empty_skips_api(client):
    with patch.object(client._embed_client.embeddings, "create", new_callable=AsyncMock) as mock_create:
        result = await client.embed_batch([])
        assert result == []
        mock_create.assert_not_called()
