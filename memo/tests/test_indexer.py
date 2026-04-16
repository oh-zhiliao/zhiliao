import os
import tempfile
from unittest.mock import AsyncMock, MagicMock

import numpy as np
import pytest

from indexer import CommitIndexer
from store import KnowledgeStore


@pytest.fixture
def store():
    with tempfile.TemporaryDirectory() as tmpdir:
        s = KnowledgeStore(os.path.join(tmpdir, "test.db"))
        yield s
        s.close()


@pytest.fixture
def mock_llm():
    client = MagicMock()
    client.summarize = AsyncMock(return_value="LLM summary of changes")
    client.embed = AsyncMock(return_value=np.array([0.1, 0.2, 0.3], dtype=np.float32))
    def _make_embeddings(texts):
        return [np.array([0.1, 0.2, 0.3], dtype=np.float32) for _ in texts]
    client.embed_batch = AsyncMock(side_effect=_make_embeddings)
    return client


@pytest.mark.asyncio
async def test_index_commits(store, mock_llm):
    indexer = CommitIndexer(store=store, llm=mock_llm)

    commits = [
        {"hash": "abc1234", "message": "feat: add login", "author": "Alice",
         "date": "2026-04-02", "diff_stat": "+50 -10"},
        {"hash": "def5678", "message": "fix: password", "author": "Bob",
         "date": "2026-04-02", "diff_stat": "+5 -2"},
    ]

    count = await indexer.index_commits("my-repo", commits)
    assert count == 2

    # Verify stored
    entry = store.get("my-repo:commit:abc1234")
    assert entry is not None
    assert "feat: add login" in entry.content
    assert entry.entry_type == "commit"
    assert entry.repo_name == "my-repo"


@pytest.mark.asyncio
async def test_index_commits_generates_daily_summary(store, mock_llm):
    indexer = CommitIndexer(store=store, llm=mock_llm)

    commits = [
        {"hash": "abc1234", "message": "feat: login", "author": "Alice",
         "date": "2026-04-02", "diff_stat": "+50 -10"},
    ]

    await indexer.index_commits("my-repo", commits)

    # Should also create a daily summary entry
    daily = store.get("my-repo:daily:2026-04-02")
    assert daily is not None
    assert daily.entry_type == "commit"
    assert "LLM summary" in daily.summary


@pytest.mark.asyncio
async def test_index_commits_empty(store, mock_llm):
    indexer = CommitIndexer(store=store, llm=mock_llm)
    count = await indexer.index_commits("my-repo", [])
    assert count == 0
    mock_llm.summarize.assert_not_called()


@pytest.mark.asyncio
async def test_index_commits_multiple_dates(store, mock_llm):
    indexer = CommitIndexer(store=store, llm=mock_llm)

    commits = [
        {"hash": "aaa1111", "message": "feat: day1 change", "author": "Alice",
         "date": "2026-04-01", "diff_stat": "+10 -2"},
        {"hash": "bbb2222", "message": "fix: day2 change", "author": "Bob",
         "date": "2026-04-02", "diff_stat": "+3 -1"},
    ]

    count = await indexer.index_commits("my-repo", commits)
    assert count == 2

    # Verify two separate daily summary entries are created
    daily1 = store.get("my-repo:daily:2026-04-01")
    daily2 = store.get("my-repo:daily:2026-04-02")
    assert daily1 is not None
    assert daily2 is not None
    assert daily1.source_file == "changes/2026-04-01"
    assert daily2.source_file == "changes/2026-04-02"


@pytest.mark.asyncio
async def test_index_commits_idempotent(store, mock_llm):
    indexer = CommitIndexer(store=store, llm=mock_llm)

    commits = [
        {"hash": "abc1234", "message": "feat: login", "author": "Alice",
         "date": "2026-04-02", "diff_stat": "+50 -10"},
    ]

    await indexer.index_commits("my-repo", commits)
    await indexer.index_commits("my-repo", commits)

    # Verify only one commit entry exists (upsert, not duplicate)
    entry = store.get("my-repo:commit:abc1234")
    assert entry is not None

    # Count all entries for this repo to verify no duplicates
    all_entries = store.list_by_repo("my-repo")
    commit_entries = [e for e in all_entries if e.id == "my-repo:commit:abc1234"]
    assert len(commit_entries) == 1
