import hashlib
import logging
import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)

from config import load_config
from decay import DecayManager
from indexer import CommitIndexer
from llm_client import LLMClient
from search import HybridSearch
from store import KnowledgeStore, KnowledgeEntry

_start_time = time.time()


# --- App state ---

class AppState:
    store: Optional[KnowledgeStore] = None
    llm: Optional[LLMClient] = None
    indexer: Optional[CommitIndexer] = None
    search: Optional[HybridSearch] = None
    decay: Optional[DecayManager] = None


state = AppState()


def _require_initialized():
    if state.indexer is None:
        raise HTTPException(status_code=503, detail="Service not initialized")


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        config = load_config()
    except ValueError:
        # Allow running without config for tests
        yield
        return

    state.store = KnowledgeStore(f"{config.data_dir}/knowledge.db")
    state.llm = LLMClient(
        llm_base_url=config.llm_base_url,
        llm_model=config.llm_model,
        llm_api_key=config.llm_api_key,
        embedding_base_url=config.embedding_base_url,
        embedding_model=config.embedding_model,
    )
    state.indexer = CommitIndexer(store=state.store, llm=state.llm)
    state.search = HybridSearch(store=state.store, llm=state.llm)
    state.decay = DecayManager(store=state.store, decay_after_days=config.decay_after_days)

    logger.info("Memo service initialized (data_dir=%s)", config.data_dir)
    yield
    state.store.close()


app = FastAPI(title="Zhiliao Memo Service", lifespan=lifespan)


# --- Request/Response Models ---


class CommitEntry(BaseModel):
    hash: str
    message: str
    author: str
    date: str
    diff_stat: str = ""


class IndexCommitsRequest(BaseModel):
    repo_name: str
    commits: list[CommitEntry]


class IndexCommitsResponse(BaseModel):
    indexed_count: int


class IndexScanRequest(BaseModel):
    repo_name: str
    repo_path: str


class IndexScanResponse(BaseModel):
    status: str
    files_scanned: int = 0


class IndexDecayRequest(BaseModel):
    repo_name: str
    existing_files: list[str]


class IndexDecayResponse(BaseModel):
    stale_count: int
    archived_count: int


class SaveRequest(BaseModel):
    repo_name: str
    source: str  # e.g. "chat:group_id" or "chat:user_id"
    content: str
    summary: str


class SaveResponse(BaseModel):
    id: str
    status: str


class SearchRequest(BaseModel):
    query: str
    repo_name: Optional[str] = None
    limit: int = 10


class SearchResponse(BaseModel):
    results: list[dict]


class HealthResponse(BaseModel):
    status: str
    uptime_seconds: float


# --- Endpoints ---


@app.get("/health", response_model=HealthResponse)
async def health():
    return HealthResponse(
        status="ok",
        uptime_seconds=round(time.time() - _start_time, 2),
    )


@app.post("/index/commits", response_model=IndexCommitsResponse)
async def index_commits(req: IndexCommitsRequest):
    _require_initialized()
    commits = [c.model_dump() for c in req.commits]
    count = await state.indexer.index_commits(req.repo_name, commits)
    return IndexCommitsResponse(indexed_count=count)


@app.post("/index/scan", response_model=IndexScanResponse)
async def index_scan(req: IndexScanRequest):
    # Scan indexing is handled by the Deep Scanner on the TS side;
    # the scan endpoint receives file summaries to index.
    # For now, acknowledge receipt. Full scan indexing will be added
    # when the TS DeepScanner sends file contents.
    return IndexScanResponse(status="accepted", files_scanned=0)


@app.post("/index/decay", response_model=IndexDecayResponse)
async def index_decay(req: IndexDecayRequest):
    _require_initialized()
    result = state.decay.run_decay(req.repo_name, req.existing_files)
    return IndexDecayResponse(
        stale_count=result["stale_count"],
        archived_count=result["archived_count"],
    )


@app.post("/save", response_model=SaveResponse)
async def save(req: SaveRequest):
    _require_initialized()

    # Distill content using cheap LLM
    distilled = await state.llm.summarize(
        f"Distill the following into a concise knowledge entry (1-3 sentences, plain language, keep only the core technical fact):\n\n{req.content}",
        max_tokens=256,
    )

    entry_id = f"{req.repo_name}:qa:{hashlib.sha256(req.content.encode()).hexdigest()[:12]}"
    embedding = await state.llm.embed(distilled)
    entry = KnowledgeEntry(
        id=entry_id,
        repo_name=req.repo_name,
        source_file=req.source,
        content=distilled,
        summary=req.summary,
        embedding=embedding,
        entry_type="qa",
    )
    state.store.upsert(entry)
    return SaveResponse(id=entry_id, status="saved")


@app.post("/search", response_model=SearchResponse)
async def search(req: SearchRequest):
    _require_initialized()
    results = await state.search.search(
        req.query, limit=req.limit, repo_name=req.repo_name
    )
    return SearchResponse(results=results)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8090)
