import os
import tempfile
import time

import numpy as np
import pytest

from store import KnowledgeEntry, KnowledgeStore


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


# --- Tests for get_entries_by_source ---

def test_get_entries_by_source(store):
    store.upsert(KnowledgeEntry(
        id="k1", repo_name="proj", source_file="src/main.ts",
        content="main content", summary="main", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code",
    ))
    store.upsert(KnowledgeEntry(
        id="k2", repo_name="proj", source_file="src/main.ts",
        content="also main", summary="main2", embedding=np.zeros(3, dtype=np.float32),
        entry_type="commit",
    ))
    store.upsert(KnowledgeEntry(
        id="k3", repo_name="proj", source_file="src/other.ts",
        content="other content", summary="other", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code",
    ))
    store.upsert(KnowledgeEntry(
        id="k4", repo_name="other-proj", source_file="src/main.ts",
        content="different repo", summary="diff", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code",
    ))

    results = store.get_entries_by_source("proj", "src/main.ts")
    assert len(results) == 2
    result_ids = {r.id for r in results}
    assert result_ids == {"k1", "k2"}


def test_get_entries_by_source_no_match(store):
    store.upsert(KnowledgeEntry(
        id="k1", repo_name="proj", source_file="src/main.ts",
        content="main", summary="main", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code",
    ))

    results = store.get_entries_by_source("proj", "src/nonexistent.ts")
    assert results == []


# --- Tests for count_by_status ---

def test_count_by_status(store):
    store.upsert(KnowledgeEntry(
        id="k1", repo_name="proj", source_file="a.ts",
        content="a", summary="a", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code", status="active",
    ))
    store.upsert(KnowledgeEntry(
        id="k2", repo_name="proj", source_file="b.ts",
        content="b", summary="b", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code", status="active",
    ))
    store.upsert(KnowledgeEntry(
        id="k3", repo_name="proj", source_file="c.ts",
        content="c", summary="c", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code", status="stale",
    ))
    store.upsert(KnowledgeEntry(
        id="k4", repo_name="other", source_file="d.ts",
        content="d", summary="d", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code", status="active",
    ))

    assert store.count_by_status("proj", "active") == 2
    assert store.count_by_status("proj", "stale") == 1
    assert store.count_by_status("proj", "archived") == 0
    assert store.count_by_status("other", "active") == 1


# --- Tests for archive_old_stale ---

def test_archive_old_stale(store):
    old_time = time.time() - 40 * 86400  # 40 days ago
    recent_time = time.time() - 5 * 86400  # 5 days ago

    store.upsert(KnowledgeEntry(
        id="k1", repo_name="proj", source_file="old.ts",
        content="old stale", summary="old", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code", status="stale", last_verified_at=old_time,
    ))
    store.upsert(KnowledgeEntry(
        id="k2", repo_name="proj", source_file="recent.ts",
        content="recent stale", summary="recent", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code", status="stale", last_verified_at=recent_time,
    ))
    store.upsert(KnowledgeEntry(
        id="k3", repo_name="proj", source_file="active.ts",
        content="active", summary="active", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code", status="active", last_verified_at=old_time,
    ))

    store.archive_old_stale(days=30)

    # k1: stale + old => archived
    assert store.get("k1").status == "archived"
    # k2: stale + recent => still stale
    assert store.get("k2").status == "stale"
    # k3: active + old => still active (only stale entries are archived)
    assert store.get("k3").status == "active"


# --- Tests for fts_search with repo_name filter ---

def test_fts_search_with_repo_filter(store):
    store.upsert(KnowledgeEntry(
        id="k1", repo_name="proj-a", source_file="auth.ts",
        content="Authentication module handles login",
        summary="Auth", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code",
    ))
    store.upsert(KnowledgeEntry(
        id="k2", repo_name="proj-b", source_file="auth.ts",
        content="Authentication service for proj-b",
        summary="Auth", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code",
    ))

    results = store.fts_search("Authentication", repo_name="proj-a")
    assert len(results) == 1
    assert results[0].id == "k1"

    results = store.fts_search("Authentication", repo_name="proj-b")
    assert len(results) == 1
    assert results[0].id == "k2"


# --- Tests for fts_search with FTS5 special characters ---

def test_fts_search_special_characters(store):
    store.upsert(KnowledgeEntry(
        id="k1", repo_name="proj", source_file="logic.ts",
        content="The server handles AND operations for boolean logic",
        summary="Boolean logic", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code",
    ))

    # FTS5 operators like AND, OR, NOT, * should be safely escaped
    results = store.fts_search("AND operations", limit=5)
    assert len(results) >= 1
    assert results[0].id == "k1"

    results = store.fts_search("OR boolean", limit=5)
    # Should not crash even though OR is an FTS5 operator
    # May or may not find results depending on quoting, but must not raise
    assert isinstance(results, list)

    # Wildcard and quotes should be safe
    results = store.fts_search('server* "handles"', limit=5)
    assert isinstance(results, list)


# --- Tests for fts_search with empty query ---

def test_fts_search_empty_query(store):
    store.upsert(KnowledgeEntry(
        id="k1", repo_name="proj", source_file="a.ts",
        content="some content", summary="summary", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code",
    ))

    assert store.fts_search("") == []
    assert store.fts_search("   ") == []


# --- Tests for vector_search with repo_name filter ---

def test_vector_search_with_repo_filter(store):
    v1 = np.array([1.0, 0.0, 0.0], dtype=np.float32)
    v2 = np.array([0.9, 0.1, 0.0], dtype=np.float32)
    store.upsert(KnowledgeEntry(
        id="k1", repo_name="proj-a", source_file="a.ts",
        content="content a", summary="a", embedding=v1, entry_type="code",
    ))
    store.upsert(KnowledgeEntry(
        id="k2", repo_name="proj-b", source_file="b.ts",
        content="content b", summary="b", embedding=v2, entry_type="code",
    ))

    query_vec = np.array([1.0, 0.0, 0.0], dtype=np.float32)

    results = store.vector_search(query_vec, limit=10, repo_name="proj-a")
    assert len(results) == 1
    assert results[0].id == "k1"

    results = store.vector_search(query_vec, limit=10, repo_name="proj-b")
    assert len(results) == 1
    assert results[0].id == "k2"


# --- Tests for vector_search on empty table ---

def test_vector_search_empty_table(store):
    query_vec = np.array([1.0, 0.0, 0.0], dtype=np.float32)
    results = store.vector_search(query_vec, limit=10)
    assert results == []


# --- Tests for vector_search with zero-norm embedding ---

def test_vector_search_zero_norm_embedding(store):
    zero_vec = np.zeros(3, dtype=np.float32)
    normal_vec = np.array([1.0, 0.0, 0.0], dtype=np.float32)

    store.upsert(KnowledgeEntry(
        id="k1", repo_name="proj", source_file="zero.ts",
        content="zero embedding", summary="zero", embedding=zero_vec, entry_type="code",
    ))
    store.upsert(KnowledgeEntry(
        id="k2", repo_name="proj", source_file="normal.ts",
        content="normal embedding", summary="normal", embedding=normal_vec, entry_type="code",
    ))

    query_vec = np.array([1.0, 0.0, 0.0], dtype=np.float32)
    results = store.vector_search(query_vec, limit=10)
    assert len(results) == 2
    # Normal vector should rank first (cosine sim = 1.0), zero vector last (cosine sim = 0.0)
    assert results[0].id == "k2"
    assert results[1].id == "k1"

    # Querying with a zero vector should also not crash
    zero_query = np.zeros(3, dtype=np.float32)
    results = store.vector_search(zero_query, limit=10)
    assert len(results) == 2
    # Both similarities are 0.0 so order is unspecified, just check no crash


# --- Test FTS consistency after update ---

def test_fts_consistency_after_update(store):
    store.upsert(KnowledgeEntry(
        id="k1", repo_name="proj", source_file="mod.ts",
        content="original unicorn rainbow content",
        summary="original summary", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code",
    ))

    # Verify original content is findable
    results = store.fts_search("unicorn", limit=5)
    assert len(results) == 1
    assert results[0].id == "k1"

    # Update with new content
    store.upsert(KnowledgeEntry(
        id="k1", repo_name="proj", source_file="mod.ts",
        content="updated xylophone orchestra content",
        summary="updated summary", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code",
    ))

    # Old content should not be found
    results = store.fts_search("unicorn", limit=5)
    assert len(results) == 0

    # New content should be found
    results = store.fts_search("xylophone", limit=5)
    assert len(results) == 1
    assert results[0].id == "k1"
    assert results[0].content == "updated xylophone orchestra content"


# --- Test delete_archived cleans FTS entries ---

def test_delete_archived_cleans_fts(store):
    store.upsert(KnowledgeEntry(
        id="k1", repo_name="proj", source_file="archived.ts",
        content="platypus marsupial koala unique content",
        summary="archived stuff", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code", status="archived",
    ))
    store.upsert(KnowledgeEntry(
        id="k2", repo_name="proj", source_file="active.ts",
        content="active content remains",
        summary="active stuff", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code", status="active",
    ))

    # Before delete, FTS has the archived entry's content
    fts_count = store.db.execute(
        "SELECT COUNT(*) FROM knowledge_fts WHERE id = ?", ("k1",)
    ).fetchone()[0]
    assert fts_count == 1

    store.delete_archived()

    # After delete, FTS should no longer have the archived entry
    fts_count = store.db.execute(
        "SELECT COUNT(*) FROM knowledge_fts WHERE id = ?", ("k1",)
    ).fetchone()[0]
    assert fts_count == 0

    # Active entry's FTS should still exist
    fts_count = store.db.execute(
        "SELECT COUNT(*) FROM knowledge_fts WHERE id = ?", ("k2",)
    ).fetchone()[0]
    assert fts_count == 1


# --- Tests for refresh_verified batch ---

def test_refresh_verified_batch(store):
    old_time = time.time() - 100000
    store.upsert(KnowledgeEntry(
        id="k1", repo_name="proj", source_file="a.ts",
        content="a", summary="a", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code", last_verified_at=old_time,
    ))
    store.upsert(KnowledgeEntry(
        id="k2", repo_name="proj", source_file="b.ts",
        content="b", summary="b", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code", last_verified_at=old_time,
    ))
    store.upsert(KnowledgeEntry(
        id="k3", repo_name="proj", source_file="c.ts",
        content="c", summary="c", embedding=np.zeros(3, dtype=np.float32),
        entry_type="code", last_verified_at=old_time,
    ))

    now = time.time()
    store.refresh_verified(["k1", "k3"], now)

    assert store.get("k1").last_verified_at == now
    assert store.get("k2").last_verified_at == old_time  # not refreshed
    assert store.get("k3").last_verified_at == now


def test_refresh_verified_empty_list(store):
    # Should not raise
    store.refresh_verified([], time.time())


# --- Tests for upsert FTS atomicity ---

def test_upsert_fts_atomic(store):
    entry = KnowledgeEntry(
        id="k1", repo_name="proj", source_file="a.ts",
        content="atomic test content", summary="atomic",
        embedding=np.zeros(3, dtype=np.float32), entry_type="code",
    )
    store.upsert(entry)

    # FTS should have exactly 1 row for this id
    count = store.db.execute(
        "SELECT COUNT(*) FROM knowledge_fts WHERE id = ?", ("k1",)
    ).fetchone()[0]
    assert count == 1

    # Upsert again with different content
    entry.content = "updated atomic content"
    store.upsert(entry)

    # Still exactly 1 FTS row
    count = store.db.execute(
        "SELECT COUNT(*) FROM knowledge_fts WHERE id = ?", ("k1",)
    ).fetchone()[0]
    assert count == 1
