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
