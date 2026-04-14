import os
import tempfile
import numpy as np
import pytest
from store import KnowledgeStore, KnowledgeEntry


@pytest.fixture
def store():
    with tempfile.TemporaryDirectory() as tmpdir:
        s = KnowledgeStore(os.path.join(tmpdir, "test.db"))
        yield s
        s.close()


def test_upsert_and_get(store):
    entry = KnowledgeEntry(
        id="k1",
        repo_name="proj",
        source_file="src/main.ts",
        content="The main entry point initializes the server",
        summary="Main entry point",
        embedding=np.array([0.1, 0.2, 0.3], dtype=np.float32),
        entry_type="code",
    )
    store.upsert(entry)

    result = store.get("k1")
    assert result is not None
    assert result.id == "k1"
    assert result.content == "The main entry point initializes the server"
    assert result.source_file == "src/main.ts"
    np.testing.assert_array_almost_equal(result.embedding, [0.1, 0.2, 0.3])


def test_upsert_updates_existing(store):
    entry = KnowledgeEntry(
        id="k1", repo_name="proj", source_file="src/a.ts",
        content="old", summary="old", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code",
    )
    store.upsert(entry)

    entry.content = "new content"
    entry.summary = "new summary"
    store.upsert(entry)

    result = store.get("k1")
    assert result.content == "new content"


def test_fts_search(store):
    store.upsert(KnowledgeEntry(
        id="k1", repo_name="proj", source_file="src/auth.ts",
        content="Authentication module handles JWT tokens and session management",
        summary="Auth module", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code",
    ))
    store.upsert(KnowledgeEntry(
        id="k2", repo_name="proj", source_file="src/db.ts",
        content="Database layer with SQLite connection pooling",
        summary="DB layer", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code",
    ))

    results = store.fts_search("JWT authentication", limit=5)
    assert len(results) >= 1
    assert results[0].id == "k1"


def test_vector_search(store):
    v1 = np.array([1.0, 0.0, 0.0], dtype=np.float32)
    v2 = np.array([0.0, 1.0, 0.0], dtype=np.float32)
    store.upsert(KnowledgeEntry(
        id="k1", repo_name="proj", source_file="a.ts",
        content="content a", summary="a", embedding=v1, entry_type="code",
    ))
    store.upsert(KnowledgeEntry(
        id="k2", repo_name="proj", source_file="b.ts",
        content="content b", summary="b", embedding=v2, entry_type="code",
    ))

    query_vec = np.array([0.9, 0.1, 0.0], dtype=np.float32)
    results = store.vector_search(query_vec, limit=2)
    assert len(results) == 2
    assert results[0].id == "k1"  # closest to query


def test_list_by_repo(store):
    store.upsert(KnowledgeEntry(
        id="k1", repo_name="proj-a", source_file="a.ts",
        content="a", summary="a", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code",
    ))
    store.upsert(KnowledgeEntry(
        id="k2", repo_name="proj-b", source_file="b.ts",
        content="b", summary="b", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code",
    ))

    results = store.list_by_repo("proj-a")
    assert len(results) == 1
    assert results[0].id == "k1"


def test_mark_stale_and_list(store):
    store.upsert(KnowledgeEntry(
        id="k1", repo_name="proj", source_file="old.ts",
        content="old", summary="old", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code",
    ))
    store.mark_stale(["k1"])

    result = store.get("k1")
    assert result.status == "stale"


def test_delete_archived(store):
    store.upsert(KnowledgeEntry(
        id="k1", repo_name="proj", source_file="gone.ts",
        content="gone", summary="gone", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code", status="archived",
    ))
    store.delete_archived()

    result = store.get("k1")
    assert result is None
