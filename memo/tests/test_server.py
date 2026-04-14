import os
import tempfile
import pytest
from unittest.mock import MagicMock, AsyncMock
import numpy as np
from httpx import AsyncClient, ASGITransport
from server import app, state
from store import KnowledgeStore, KnowledgeEntry
from llm_client import LLMClient
from indexer import CommitIndexer
from search import HybridSearch
from decay import DecayManager


@pytest.fixture
def setup_state():
    """Set up real store + mock LLM for integration tests."""
    with tempfile.TemporaryDirectory() as tmpdir:
        store = KnowledgeStore(os.path.join(tmpdir, "test.db"))
        mock_llm = MagicMock(spec=LLMClient)
        mock_llm.summarize = AsyncMock(return_value="Test summary")
        mock_llm.embed = AsyncMock(return_value=np.zeros(16, dtype=np.float32))
        mock_llm.embed_batch = AsyncMock(side_effect=lambda texts: [np.zeros(16, dtype=np.float32) for _ in texts])

        state.store = store
        state.llm = mock_llm
        state.indexer = CommitIndexer(store=store, llm=mock_llm)
        state.search = HybridSearch(store=store, llm=mock_llm)
        state.decay = DecayManager(store=store, decay_after_days=30)

        yield store
        store.close()


@pytest.fixture
def client(setup_state):
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


@pytest.mark.asyncio
async def test_health(client):
    resp = await client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "uptime_seconds" in data


@pytest.mark.asyncio
async def test_index_commits(client, setup_state):
    resp = await client.post(
        "/index/commits",
        json={
            "repo_name": "test-repo",
            "commits": [
                {
                    "hash": "abc1234",
                    "message": "feat: add login",
                    "author": "dev",
                    "date": "2026-04-02T10:00:00+08:00",
                    "diff_stat": "2 files changed",
                }
            ],
        },
    )
    assert resp.status_code == 200
    assert resp.json()["indexed_count"] == 1

    # Verify actually stored
    entry = setup_state.get("test-repo:commit:abc1234")
    assert entry is not None


@pytest.mark.asyncio
async def test_index_decay(client, setup_state):
    # Seed a code entry
    setup_state.upsert(KnowledgeEntry(
        id="k1", repo_name="test-repo", source_file="src/gone.ts",
        content="old code", summary="old", embedding=np.zeros(16, dtype=np.float32),
        entry_type="code",
    ))

    resp = await client.post(
        "/index/decay",
        json={
            "repo_name": "test-repo",
            "existing_files": [],  # src/gone.ts is missing
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["stale_count"] == 1


@pytest.mark.asyncio
async def test_search(client, setup_state):
    # Seed data
    setup_state.upsert(KnowledgeEntry(
        id="k1", repo_name="proj", source_file="src/auth.ts",
        content="JWT authentication handler",
        summary="Auth handler",
        embedding=np.ones(16, dtype=np.float32),
        entry_type="code",
    ))

    resp = await client.post(
        "/search",
        json={"query": "JWT authentication", "limit": 5},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["results"]) >= 1


@pytest.mark.asyncio
async def test_index_scan(client):
    resp = await client.post(
        "/index/scan",
        json={"repo_name": "test-repo", "repo_path": "/tmp/fake"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "accepted"


@pytest.mark.asyncio
async def test_returns_503_when_not_initialized():
    """Endpoints return 503 when state is not initialized."""
    # Save and clear state
    saved = (state.indexer, state.decay, state.search)
    state.indexer = None
    state.decay = None
    state.search = None
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.post("/index/commits", json={"repo_name": "r", "commits": []})
            assert resp.status_code == 503
            resp = await c.post("/search", json={"query": "test"})
            assert resp.status_code == 503
    finally:
        state.indexer, state.decay, state.search = saved
