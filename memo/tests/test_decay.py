import os
import tempfile
import time
import numpy as np
import pytest

from decay import DecayManager
from store import KnowledgeStore, KnowledgeEntry


@pytest.fixture
def store():
    with tempfile.TemporaryDirectory() as tmpdir:
        s = KnowledgeStore(os.path.join(tmpdir, "test.db"))
        yield s
        s.close()


def _make_entry(id: str, repo: str, source: str, status: str = "active", verified_at: float = None):
    return KnowledgeEntry(
        id=id, repo_name=repo, source_file=source,
        content=f"content of {source}", summary=f"summary of {source}",
        embedding=np.zeros(3, dtype=np.float32), entry_type="code",
        status=status, last_verified_at=verified_at or time.time(),
    )


def test_decay_marks_missing_files_stale(store):
    store.upsert(_make_entry("k1", "proj", "src/exists.ts"))
    store.upsert(_make_entry("k2", "proj", "src/deleted.ts"))

    decay = DecayManager(store=store, decay_after_days=30)
    result = decay.run_decay("proj", existing_files=["src/exists.ts"])

    assert result["stale_count"] == 1
    assert store.get("k2").status == "stale"
    assert store.get("k1").status == "active"


def test_decay_refreshes_existing_files(store):
    old_time = time.time() - 100000
    store.upsert(_make_entry("k1", "proj", "src/main.ts", verified_at=old_time))

    decay = DecayManager(store=store, decay_after_days=30)
    decay.run_decay("proj", existing_files=["src/main.ts"])

    refreshed = store.get("k1")
    assert refreshed.last_verified_at > old_time


def test_decay_archives_old_stale(store):
    old_time = time.time() - 86400 * 60  # 60 days ago
    store.upsert(_make_entry("k1", "proj", "src/old.ts", status="stale", verified_at=old_time))

    decay = DecayManager(store=store, decay_after_days=30)
    result = decay.run_decay("proj", existing_files=[])

    assert result["archived_count"] >= 1


def test_decay_ignores_commit_entries(store):
    store.upsert(KnowledgeEntry(
        id="c1", repo_name="proj", source_file="commits/2026-04-02",
        content="commit", summary="commit", embedding=np.zeros(3, dtype=np.float32),
        entry_type="commit",
    ))

    decay = DecayManager(store=store, decay_after_days=30)
    result = decay.run_decay("proj", existing_files=[])

    assert store.get("c1").status == "active"


def test_decay_ignores_qa_entries(store):
    store.upsert(KnowledgeEntry(
        id="q1", repo_name="proj", source_file="qa/some-question",
        content="content of qa/some-question", summary="summary of qa/some-question",
        embedding=np.zeros(3, dtype=np.float32), entry_type="qa",
    ))

    decay = DecayManager(store=store, decay_after_days=30)
    result = decay.run_decay("proj", existing_files=[])

    assert store.get("q1").status == "active"


def test_decay_mixed_types(store):
    # code entry whose source file is missing
    store.upsert(_make_entry("code1", "proj", "src/missing.ts"))
    # commit entry
    store.upsert(KnowledgeEntry(
        id="commit1", repo_name="proj", source_file="commits/2026-04-01",
        content="commit content", summary="commit summary",
        embedding=np.zeros(3, dtype=np.float32), entry_type="commit",
    ))
    # qa entry
    store.upsert(KnowledgeEntry(
        id="qa1", repo_name="proj", source_file="qa/question",
        content="qa content", summary="qa summary",
        embedding=np.zeros(3, dtype=np.float32), entry_type="qa",
    ))

    decay = DecayManager(store=store, decay_after_days=30)
    result = decay.run_decay("proj", existing_files=[])

    # Only code entry should be stale
    assert store.get("code1").status == "stale"
    assert store.get("commit1").status == "active"
    assert store.get("qa1").status == "active"
    assert result["stale_count"] == 1


def test_decay_batch_refresh_efficiency(store):
    """Decay should use batch refresh, not N+1 get+upsert."""
    # Create 5 code entries whose files exist
    for i in range(5):
        store.upsert(_make_entry(f"k{i}", "proj", f"src/file{i}.ts",
                                  verified_at=time.time() - 100000))

    existing_files = [f"src/file{i}.ts" for i in range(5)]

    # Track store.get calls
    original_get = store.get
    get_call_count = 0
    def counting_get(*args, **kwargs):
        nonlocal get_call_count
        get_call_count += 1
        return original_get(*args, **kwargs)
    store.get = counting_get

    decay = DecayManager(store=store, decay_after_days=30)
    decay.run_decay("proj", existing_files=existing_files)

    # Should NOT call get() 5 times for refreshing (old N+1 pattern)
    # With batch refresh, get() should be called 0 times for refresh
    assert get_call_count == 0, f"Expected 0 get() calls for refresh, got {get_call_count}"

    # But timestamps should still be refreshed
    for i in range(5):
        entry = original_get(f"k{i}")
        assert entry.last_verified_at > time.time() - 10  # recently refreshed
