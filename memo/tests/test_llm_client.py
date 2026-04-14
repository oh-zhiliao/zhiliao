import numpy as np
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
