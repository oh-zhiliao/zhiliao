import re
from collections import defaultdict

from llm_client import LLMClient
from store import KnowledgeEntry, KnowledgeStore

ROLE_PATH_RE = re.compile(r"(?:^|/)roles/([^/]+)/")


class CommitIndexer:
    def __init__(self, store: KnowledgeStore, llm: LLMClient):
        self.store = store
        self.llm = llm

    async def index_commits(self, repo_name: str, commits: list[dict]) -> int:
        if not commits:
            return 0

        scoped_entries: list[tuple[dict, str, str]] = []
        by_scope_and_date: dict[tuple[str, str], list[dict]] = defaultdict(list)

        for commit in commits:
            date_key = commit["date"][:10]
            for role in self._roles_for_commit(commit):
                content = self._format_commit(commit, role)
                scoped_entries.append((commit, role, content))
                by_scope_and_date[(date_key, role)].append(commit)

        # Format all commits and batch-embed
        contents = [content for _, _, content in scoped_entries]
        embeddings = await self.llm.embed_batch(contents)
        for (commit, role, content), embedding in zip(scoped_entries, embeddings, strict=True):
            entry_id = self._commit_entry_id(repo_name, commit["hash"], role)

            entry = KnowledgeEntry(
                id=entry_id,
                repo_name=repo_name,
                source_file=f"commits/{commit['date'][:10]}",
                content=content,
                summary=commit["message"],
                embedding=embedding,
                entry_type="commit",
                role=role,
            )
            self.store.upsert(entry)

        # Generate daily summaries
        for (date_key, role), day_commits in by_scope_and_date.items():
            await self._create_daily_summary(repo_name, date_key, role, day_commits)

        return len(commits)

    async def _create_daily_summary(
        self, repo_name: str, date: str, role: str, commits: list[dict]
    ):
        lines = [self._daily_summary_line(c, role) for c in commits]
        prompt = (
            f"Summarize these git commits from {date} in the {repo_name} repository "
            f"for the {role} role in 2-3 sentences. Focus on what changed and why.\n\n"
            + "\n".join(lines)
        )

        summary = await self.llm.summarize(prompt)
        content = f"## Changes on {date}\n\n{summary}\n\nCommits:\n" + "\n".join(lines)
        embedding = await self.llm.embed(content)

        entry = KnowledgeEntry(
            id=self._daily_entry_id(repo_name, date, role),
            repo_name=repo_name,
            source_file=f"changes/{date}",
            content=content,
            summary=summary,
            embedding=embedding,
            entry_type="commit",
            role=role,
        )
        self.store.upsert(entry)

    @staticmethod
    def _commit_entry_id(repo_name: str, commit_hash: str, role: str) -> str:
        if role == "default":
            return f"{repo_name}:commit:{commit_hash}"
        return f"{repo_name}:commit:{commit_hash}:{role}"

    @staticmethod
    def _daily_entry_id(repo_name: str, date: str, role: str) -> str:
        if role == "default":
            return f"{repo_name}:daily:{date}"
        return f"{repo_name}:daily:{date}:{role}"

    def _format_commit(self, commit: dict, role: str) -> str:
        lines = [
            f"Commit {commit['hash'][:7]} by {commit['author']} on {commit['date'][:10]}",
            f"Message: {commit['message']}",
        ]
        visible_files = self._visible_files_for_role(commit, role)
        if visible_files:
            lines.append("Files: " + ", ".join(visible_files))
        elif commit.get("diff_stat"):
            lines.append(f"Changes: {commit.get('diff_stat', '')}")
        return "\n".join(lines)

    def _daily_summary_line(self, commit: dict, role: str) -> str:
        visible_files = self._visible_files_for_role(commit, role)
        if visible_files:
            return f"- {commit['hash'][:7]} {commit['message']} ({commit['author']}) [{', '.join(visible_files)}]"
        return f"- {commit['hash'][:7]} {commit['message']} ({commit['author']})"

    def _roles_for_commit(self, commit: dict) -> list[str]:
        matched_roles = {
            match.group(1)
            for path in commit.get("changed_files", [])
            if (match := ROLE_PATH_RE.search(path))
        }
        has_unscoped_files = any(
            ROLE_PATH_RE.search(path) is None
            for path in commit.get("changed_files", [])
        )
        if has_unscoped_files or not matched_roles:
            matched_roles.add("default")
        return sorted(matched_roles)

    def _visible_files_for_role(self, commit: dict, role: str) -> list[str]:
        visible_files: list[str] = []
        for path in commit.get("changed_files", []):
            match = ROLE_PATH_RE.search(path)
            scoped_role = match.group(1) if match else None
            if scoped_role == role:
                visible_files.append(path)
            elif scoped_role is None and role == "default":
                visible_files.append(path)
        return visible_files
