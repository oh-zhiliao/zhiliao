import time

from store import KnowledgeStore


class DecayManager:
    def __init__(self, store: KnowledgeStore, decay_after_days: int = 30):
        self.store = store
        self.decay_after_days = decay_after_days

    def run_decay(self, repo_name: str, existing_files: list[str]) -> dict:
        existing_set = set(existing_files)
        entries = self.store.list_by_repo(repo_name)

        stale_ids = []
        refresh_ids = []

        for entry in entries:
            # Only decay code entries, not commit/qa entries
            if entry.entry_type != "code":
                continue

            if entry.source_file in existing_set:
                refresh_ids.append(entry.id)
            else:
                stale_ids.append(entry.id)

        # Mark missing files as stale
        if stale_ids:
            self.store.mark_stale(stale_ids)

        # Refresh verification time for existing files
        if refresh_ids:
            now = time.time()
            self.store.refresh_verified(refresh_ids, now)

        # Archive stale entries older than threshold
        self.store.archive_old_stale(self.decay_after_days)
        archived = self.store.count_by_status(repo_name, "archived")

        # Clean up archived
        self.store.delete_archived()

        return {
            "stale_count": len(stale_ids),
            "archived_count": archived,
        }
