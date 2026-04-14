import numpy as np

from llm_client import LLMClient
from store import KnowledgeStore


class HybridSearch:
    def __init__(self, store: KnowledgeStore, llm: LLMClient):
        self.store = store
        self.llm = llm

    async def search(
        self, query: str, limit: int = 10, repo_name: str = None
    ) -> list[dict]:
        if not query.strip():
            return []

        # Run BM25 and vector search in parallel-ish (both fast locally)
        bm25_results = self.store.fts_search(query, limit=limit * 2, repo_name=repo_name)

        query_vec = await self.llm.embed(query)
        vec_results = self.store.vector_search(query_vec, limit=limit * 2, repo_name=repo_name)

        # Merge with reciprocal rank fusion (RRF)
        scores: dict[str, float] = {}
        entries: dict[str, dict] = {}

        k = 60  # RRF constant

        for rank, entry in enumerate(bm25_results):
            scores[entry.id] = scores.get(entry.id, 0) + 1.0 / (k + rank + 1)
            entries[entry.id] = self._entry_to_dict(entry)

        for rank, entry in enumerate(vec_results):
            scores[entry.id] = scores.get(entry.id, 0) + 1.0 / (k + rank + 1)
            entries[entry.id] = self._entry_to_dict(entry)

        # Sort by fused score
        ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)

        results = []
        for entry_id, score in ranked[:limit]:
            item = entries[entry_id]
            item["score"] = round(score, 6)
            results.append(item)

        return results

    @staticmethod
    def _entry_to_dict(entry) -> dict:
        return {
            "id": entry.id,
            "repo_name": entry.repo_name,
            "source_file": entry.source_file,
            "content": entry.content,
            "summary": entry.summary,
            "entry_type": entry.entry_type,
        }
