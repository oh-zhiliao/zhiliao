import os
import tempfile
import numpy as np
import pytest
from unittest.mock import AsyncMock, MagicMock

from search import HybridSearch
from store import KnowledgeStore, KnowledgeEntry


@pytest.fixture
def store():
    with tempfile.TemporaryDirectory() as tmpdir:
        s = KnowledgeStore(os.path.join(tmpdir, "test.db"))
        # Seed data
        for i, (content, vec) in enumerate([
            ("Authentication module handles JWT tokens", [1.0, 0.0, 0.0]),
            ("Database connection pooling with SQLite", [0.0, 1.0, 0.0]),
            ("User login flow with password hashing", [0.8, 0.2, 0.0]),
        ]):
            s.upsert(KnowledgeEntry(
                id=f"k{i}", repo_name="proj", source_file=f"src/{i}.ts",
                content=content, summary=content[:30],
                embedding=np.array(vec, dtype=np.float32),
                entry_type="code",
            ))
        yield s
        s.close()


@pytest.fixture
def mock_llm():
    client = MagicMock()
    # Query embedding close to "auth" vector [1.0, 0.0, 0.0]
    client.embed = AsyncMock(return_value=np.array([0.9, 0.1, 0.0], dtype=np.float32))
    return client


@pytest.mark.asyncio
async def test_hybrid_search(store, mock_llm):
    search = HybridSearch(store=store, llm=mock_llm)
    results = await search.search("JWT authentication", limit=3)

    assert len(results) >= 1
    # k0 should be top hit (matches both BM25 for "JWT authentication" and vector similarity)
    assert results[0]["id"] == "k0"
    assert "score" in results[0]
    assert "content" in results[0]


@pytest.mark.asyncio
async def test_hybrid_search_deduplicates(store, mock_llm):
    search = HybridSearch(store=store, llm=mock_llm)
    results = await search.search("authentication JWT", limit=10)

    ids = [r["id"] for r in results]
    assert len(ids) == len(set(ids))  # no duplicates


@pytest.mark.asyncio
async def test_hybrid_search_empty_query(store, mock_llm):
    mock_llm.embed = AsyncMock(return_value=np.zeros(3, dtype=np.float32))
    search = HybridSearch(store=store, llm=mock_llm)
    results = await search.search("", limit=5)
    assert isinstance(results, list)
