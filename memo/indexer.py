from collections import defaultdict

from llm_client import LLMClient
from store import KnowledgeEntry, KnowledgeStore


class CommitIndexer:
    def __init__(self, store: KnowledgeStore, llm: LLMClient):
        self.store = store
        self.llm = llm

    async def index_commits(self, repo_name: str, commits: list[dict]) -> int:
        if not commits:
            return 0

        # Format all commits and batch-embed
        contents = [self._format_commit(c) for c in commits]
        embeddings = await self.llm.embed_batch(contents)

        # Group by date for daily summaries
        by_date: dict[str, list[dict]] = defaultdict(list)

        for commit, content, embedding in zip(commits, contents, embeddings, strict=True):
            entry_id = f"{repo_name}:commit:{commit['hash']}"

            entry = KnowledgeEntry(
                id=entry_id,
                repo_name=repo_name,
                source_file=f"commits/{commit['date'][:10]}",
                content=content,
                summary=commit["message"],
                embedding=embedding,
                entry_type="commit",
            )
            self.store.upsert(entry)

            date_key = commit["date"][:10]
            by_date[date_key].append(commit)

        # Generate daily summaries
        for date_key, day_commits in by_date.items():
            await self._create_daily_summary(repo_name, date_key, day_commits)

        return len(commits)

    async def _create_daily_summary(
        self, repo_name: str, date: str, commits: list[dict]
    ):
        lines = [f"- {c['hash'][:7]} {c['message']} ({c['author']})" for c in commits]
        prompt = (
            f"Summarize these git commits from {date} in the {repo_name} repository "
            f"in 2-3 sentences. Focus on what changed and why.\n\n"
            + "\n".join(lines)
        )

        summary = await self.llm.summarize(prompt)
        content = f"## Changes on {date}\n\n{summary}\n\nCommits:\n" + "\n".join(lines)
        embedding = await self.llm.embed(content)

        entry = KnowledgeEntry(
            id=f"{repo_name}:daily:{date}",
            repo_name=repo_name,
            source_file=f"changes/{date}",
            content=content,
            summary=summary,
            embedding=embedding,
            entry_type="commit",
        )
        self.store.upsert(entry)

    @staticmethod
    def _format_commit(commit: dict) -> str:
        return (
            f"Commit {commit['hash'][:7]} by {commit['author']} on {commit['date'][:10]}\n"
            f"Message: {commit['message']}\n"
            f"Changes: {commit.get('diff_stat', '')}"
        )
