import Database from "better-sqlite3";

export class ZhiliaoDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
    );

    const versionRow = this.db
      .prepare("SELECT value FROM _meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    const currentVersion = versionRow ? parseInt(versionRow.value, 10) : 0;

    const migrations: Array<() => void> = [
      // v1: initial schema
      () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS repos (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            url TEXT NOT NULL,
            local_path TEXT NOT NULL,
            default_branch TEXT NOT NULL DEFAULT 'main',
            last_poll_at INTEGER,
            last_scan_at INTEGER,
            status TEXT NOT NULL DEFAULT 'active'
          );

          CREATE TABLE IF NOT EXISTS repo_admins (
            repo_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'admin',
            PRIMARY KEY (repo_id, user_id)
          );

          CREATE TABLE IF NOT EXISTS repo_notify_targets (
            repo_id TEXT NOT NULL,
            chat_id TEXT NOT NULL,
            notify_enabled INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (repo_id, chat_id)
          );
        `);
      },
      // v2: sessions table
      () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS sessions (
            session_key TEXT PRIMARY KEY,
            history TEXT NOT NULL,
            total_input_tokens INTEGER NOT NULL DEFAULT 0,
            total_output_tokens INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            last_accessed_at INTEGER NOT NULL
          );
        `);
      },
    ];

    for (let i = currentVersion; i < migrations.length; i++) {
      migrations[i]();
    }

    this.db
      .prepare(
        `INSERT INTO _meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(String(migrations.length));
  }

  close(): void {
    this.db.close();
  }

  // --- Sessions ---

  loadSession(sessionKey: string): { history: string; totalInputTokens: number; totalOutputTokens: number; createdAt: number; lastAccessedAt: number } | null {
    return this.db
      .prepare("SELECT history, total_input_tokens as totalInputTokens, total_output_tokens as totalOutputTokens, created_at as createdAt, last_accessed_at as lastAccessedAt FROM sessions WHERE session_key = ?")
      .get(sessionKey) as { history: string; totalInputTokens: number; totalOutputTokens: number; createdAt: number; lastAccessedAt: number } | null;
  }

  saveSession(sessionKey: string, history: string, totalInputTokens: number, totalOutputTokens: number, createdAt: number, lastAccessedAt: number): void {
    this.db.prepare(
      `INSERT INTO sessions (session_key, history, total_input_tokens, total_output_tokens, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_key) DO UPDATE SET
         history = excluded.history,
         total_input_tokens = excluded.total_input_tokens,
         total_output_tokens = excluded.total_output_tokens,
         last_accessed_at = excluded.last_accessed_at`
    ).run(sessionKey, history, totalInputTokens, totalOutputTokens, createdAt, lastAccessedAt);
  }

  deleteSession(sessionKey: string): void {
    this.db.prepare("DELETE FROM sessions WHERE session_key = ?").run(sessionKey);
  }

  cleanExpiredSessions(ttlMs: number): number {
    const cutoff = Date.now() - ttlMs;
    const result = this.db.prepare("DELETE FROM sessions WHERE last_accessed_at < ?").run(cutoff);
    return result.changes;
  }
}
