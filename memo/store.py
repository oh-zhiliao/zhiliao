import sqlite3
import time
from dataclasses import dataclass, field
from typing import Optional

import numpy as np


@dataclass
class KnowledgeEntry:
    id: str
    repo_name: str
    source_file: str
    content: str
    summary: str
    embedding: np.ndarray
    entry_type: str  # "code", "commit", "qa"
    status: str = "active"  # "active", "stale", "archived"
    last_verified_at: float = field(default_factory=time.time)
    created_at: float = field(default_factory=time.time)


class KnowledgeStore:
    def __init__(self, db_path: str):
        self.db = sqlite3.connect(db_path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self._init_tables()

    def _init_tables(self):
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS knowledge (
                id TEXT PRIMARY KEY,
                repo_name TEXT NOT NULL,
                source_file TEXT NOT NULL,
                content TEXT NOT NULL,
                summary TEXT NOT NULL,
                embedding BLOB NOT NULL,
                entry_type TEXT NOT NULL DEFAULT 'code',
                status TEXT NOT NULL DEFAULT 'active',
                last_verified_at REAL NOT NULL,
                created_at REAL NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_knowledge_repo ON knowledge(repo_name);
            CREATE INDEX IF NOT EXISTS idx_knowledge_status ON knowledge(status);
            CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge(repo_name, source_file);
        """)
        # FTS5 virtual table for BM25 text search (standalone, manually synced)
        self.db.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
                id UNINDEXED,
                content,
                summary
            )
        """)
        self.db.commit()

    def upsert(self, entry: KnowledgeEntry):
        emb_blob = entry.embedding.tobytes()
        self.db.execute("""
            INSERT INTO knowledge (id, repo_name, source_file, content, summary,
                                   embedding, entry_type, status, last_verified_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                content=excluded.content,
                summary=excluded.summary,
                embedding=excluded.embedding,
                status=excluded.status,
                last_verified_at=excluded.last_verified_at
        """, (entry.id, entry.repo_name, entry.source_file, entry.content,
              entry.summary, emb_blob, entry.entry_type, entry.status,
              entry.last_verified_at, entry.created_at))

        # Sync FTS — delete old, insert new
        self.db.execute("DELETE FROM knowledge_fts WHERE id = ?", (entry.id,))
        self.db.execute(
            "INSERT INTO knowledge_fts (id, content, summary) VALUES (?, ?, ?)",
            (entry.id, entry.content, entry.summary),
        )
        self.db.commit()

    def get(self, entry_id: str) -> Optional[KnowledgeEntry]:
        row = self.db.execute(
            "SELECT * FROM knowledge WHERE id = ?", (entry_id,)
        ).fetchone()
        if not row:
            return None
        return self._row_to_entry(row)

    def fts_search(self, query: str, limit: int = 10, repo_name: str = None) -> list[KnowledgeEntry]:
        # Quote each word to prevent FTS5 operator injection (AND, OR, NOT, NEAR, *, ^)
        words = query.split()
        if not words:
            return []
        safe_query = " ".join('"' + w.replace('"', '""') + '"' for w in words)
        where_extra = ""
        params: list = [safe_query]
        if repo_name:
            where_extra = "AND k.repo_name = ?"
            params.append(repo_name)
        params.append(limit)
        rows = self.db.execute(f"""
            SELECT k.* FROM knowledge k
            JOIN knowledge_fts fts ON k.id = fts.id
            WHERE knowledge_fts MATCH ?
            AND k.status = 'active'
            {where_extra}
            ORDER BY rank
            LIMIT ?
        """, params).fetchall()
        return [self._row_to_entry(r) for r in rows]

    def vector_search(self, query_vec: np.ndarray, limit: int = 10, repo_name: str = None) -> list[KnowledgeEntry]:
        # Load all active embeddings and compute cosine similarity
        where_clause = "WHERE status = 'active'"
        params: list = []
        if repo_name:
            where_clause += " AND repo_name = ?"
            params.append(repo_name)

        rows = self.db.execute(
            f"SELECT * FROM knowledge {where_clause}", params
        ).fetchall()

        if not rows:
            return []

        scored = []
        for row in rows:
            entry = self._row_to_entry(row)
            sim = self._cosine_similarity(query_vec, entry.embedding)
            scored.append((sim, entry))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [entry for _, entry in scored[:limit]]

    def list_by_repo(self, repo_name: str) -> list[KnowledgeEntry]:
        rows = self.db.execute(
            "SELECT * FROM knowledge WHERE repo_name = ? AND status = 'active'",
            (repo_name,),
        ).fetchall()
        return [self._row_to_entry(r) for r in rows]

    def mark_stale(self, entry_ids: list[str]):
        if not entry_ids:
            return
        placeholders = ",".join("?" * len(entry_ids))
        self.db.execute(
            f"UPDATE knowledge SET status = 'stale' WHERE id IN ({placeholders})",
            entry_ids,
        )
        self.db.commit()

    def archive_old_stale(self, days: int):
        cutoff = time.time() - days * 86400
        self.db.execute(
            "UPDATE knowledge SET status = 'archived' WHERE status = 'stale' AND last_verified_at < ?",
            (cutoff,),
        )
        self.db.commit()

    def delete_archived(self):
        self.db.execute("DELETE FROM knowledge_fts WHERE id IN (SELECT id FROM knowledge WHERE status = 'archived')")
        self.db.execute("DELETE FROM knowledge WHERE status = 'archived'")
        self.db.commit()

    def get_entries_by_source(self, repo_name: str, source_file: str) -> list[KnowledgeEntry]:
        rows = self.db.execute(
            "SELECT * FROM knowledge WHERE repo_name = ? AND source_file = ?",
            (repo_name, source_file),
        ).fetchall()
        return [self._row_to_entry(r) for r in rows]

    def count_by_status(self, repo_name: str, status: str) -> int:
        row = self.db.execute(
            "SELECT COUNT(*) FROM knowledge WHERE repo_name = ? AND status = ?",
            (repo_name, status),
        ).fetchone()
        return row[0] if row else 0

    def close(self):
        self.db.close()

    def _row_to_entry(self, row) -> KnowledgeEntry:
        return KnowledgeEntry(
            id=row[0],
            repo_name=row[1],
            source_file=row[2],
            content=row[3],
            summary=row[4],
            embedding=np.frombuffer(row[5], dtype=np.float32),
            entry_type=row[6],
            status=row[7],
            last_verified_at=row[8],
            created_at=row[9],
        )

    @staticmethod
    def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
        norm_a = np.linalg.norm(a)
        norm_b = np.linalg.norm(b)
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return float(np.dot(a, b) / (norm_a * norm_b))
