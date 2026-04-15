# Memo 知识服务

独立 Python FastAPI 服务，负责知识持久化、向量索引、混合检索和衰减管理。

## 架构

```
HTTP API (FastAPI)
  ├── POST /index/commits  → CommitIndexer
  ├── POST /index/scan     → (预留)
  ├── POST /index/decay    → DecayManager
  ├── POST /search         → HybridSearch
  └── GET  /health         → uptime
         │
    ┌────┴────┐
    ▼         ▼
LLMClient  KnowledgeStore
(embed+    (SQLite+FTS5)
 summarize)
```

## 模块说明

### config.py

从环境变量加载配置，frozen dataclass。

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `MEMO_LLM_API_KEY` | (必填) | LLM API 密钥 |
| `MEMO_LLM_BASE_URL` | deepseek | LLM 服务地址 |
| `MEMO_LLM_MODEL` | deepseek-chat | 摘要模型 |
| `MEMO_EMBEDDING_BASE_URL` | 同 LLM | Embedding 服务地址 |
| `MEMO_EMBEDDING_MODEL` | deepseek-embedding | Embedding 模型 |
| `MEMO_EMBEDDING_API_KEY` | 同 LLM key | Embedding API 密钥（可独立配置） |
| `MEMO_LLM_TIMEOUT` | 60.0 | LLM/Embedding API 超时（秒） |
| `MEMO_DATA_DIR` | /app/data | 数据目录 |
| `MEMO_DECAY_AFTER_DAYS` | 30 | 衰减天数 |

### llm_client.py

OpenAI 兼容 API 客户端，支持摘要生成和 embedding。

- `summarize(prompt, max_tokens=512)` — temperature=0.3
- `embed(text)` / `embed_batch(texts)` — 返回 numpy float32 数组
- 两个独立 AsyncOpenAI 实例（LLM + embedding 可用不同 provider 和 API key）
- **超时**: 可配置（默认 60s read / 10s connect），通过 `MEMO_LLM_TIMEOUT` 设置
- **重试**: `_retry_call()` 对瞬态错误（APITimeoutError、APIConnectionError、429、5xx）指数退避重试，最多 3 次

### store.py — KnowledgeStore

SQLite 知识存储，FTS5 全文检索 + 向量搜索。

**Schema**:
```sql
knowledge (id, repo_name, source_file, content, summary,
           embedding BLOB, entry_type, status, last_verified_at, created_at)
knowledge_fts (id, content, summary)  -- FTS5 virtual table
```

**Entry 状态流转**: `active → stale → archived → deleted`

**Entry 类型**: `commit`（提交记录）, `code`（代码文件）, `qa`（问答记录）

**事务性**: `upsert()` 在单个事务内完成 INSERT OR REPLACE + FTS5 同步，保证一致性

**批量操作**: `refresh_verified(entry_ids, now)` 单条 SQL 批量刷新 `last_verified_at`，替代 N+1 逐条更新

**并发**: WAL journal 模式，支持写入时并发读取

### indexer.py — CommitIndexer

Git commit 索引流程:
1. 格式化 commit (hash, author, date, message, diff_stat)
2. 批量 embed 所有 commit
3. 按日期分组，LLM 生成每日摘要
4. upsert 到 KnowledgeStore

### search.py — HybridSearch

混合搜索 = BM25 + 向量 + RRF 融合。

**算法**: Reciprocal Rank Fusion (k=60)
1. FTS5 搜索 → BM25 排序，取 top 2*limit
2. 向量搜索 → 余弦相似度排序，取 top 2*limit
3. RRF 打分: `score = 1/(k + rank + 1)`，双路结果合并
4. 按总分排序，返回 top limit

### decay.py — DecayManager

知识衰减周期:
1. 获取 repo 所有 entry
2. 仅处理 `code` 类型（commit/qa 不衰减）
3. source_file 仍存在 → 刷新 last_verified_at
4. source_file 已删除 → 标记 stale
5. stale 超过 N 天 → archived → 删除

## Embedding 模型

**当前**: `qwen3-embedding:0.6b` (1024 dims) via Ollama

| 模型 | 单次延迟 | 批量吞吐 | 大小 |
|------|---------|---------|------|
| qwen3-embedding:0.6b | 158ms | 7.6/s | 639MB |
| bge-m3 | 415ms | 3.0/s | 1157MB |

**注意**: 切换模型需清空 `embedding` 列并重新索引。
