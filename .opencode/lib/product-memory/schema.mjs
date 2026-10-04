export function initializeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pm_roots (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), path TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, generation INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
      overrides_json TEXT NOT NULL DEFAULT '{}', discovery_json TEXT, updated_at TEXT NOT NULL,
      UNIQUE(product_id,path)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS pm_nodes (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), root_id TEXT REFERENCES pm_roots(id),
      parent_id TEXT, relative_path TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
      source_kind TEXT, status TEXT NOT NULL, target_id TEXT REFERENCES audit_targets(id), version INTEGER NOT NULL DEFAULT 1,
      details_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL, UNIQUE(root_id,relative_path)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS pm_nodes_product ON pm_nodes(product_id,kind,status);
    CREATE TABLE IF NOT EXISTS pm_snapshots (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, repo_id TEXT NOT NULL REFERENCES pm_nodes(id), digest TEXT NOT NULL,
      source_root TEXT NOT NULL, branch_hint TEXT, complete INTEGER NOT NULL, manifest_path TEXT NOT NULL,
      summary_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(repo_id,digest,source_root)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS pm_bindings (
      audit_id TEXT PRIMARY KEY, product_id TEXT NOT NULL, repo_id TEXT NOT NULL REFERENCES pm_nodes(id),
      snapshot_id TEXT NOT NULL REFERENCES pm_snapshots(id), campaign_id TEXT, read_watermark INTEGER NOT NULL,
      mode TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS pm_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, product_id TEXT NOT NULL,
      repo_id TEXT, type TEXT NOT NULL, resource_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS pm_events_product ON pm_events(product_id,sequence);
    CREATE TABLE IF NOT EXISTS pm_observations (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, repo_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
      audit_id TEXT NOT NULL, task_id TEXT NOT NULL, session_id TEXT, kind TEXT NOT NULL, entity_key TEXT NOT NULL,
      title TEXT NOT NULL, data_json TEXT NOT NULL, evidence_json TEXT NOT NULL, trust TEXT NOT NULL,
      digest TEXT NOT NULL, event_sequence INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(audit_id,task_id,digest)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS pm_observations_query ON pm_observations(product_id,repo_id,kind,snapshot_id,event_sequence);
    CREATE TABLE IF NOT EXISTS pm_issues (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, repo_id TEXT NOT NULL, title TEXT NOT NULL,
      human_verdict TEXT NOT NULL DEFAULT 'UNREVIEWED', remediation TEXT NOT NULL DEFAULT 'OPEN',
      duplicate_of TEXT, version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS pm_issue_observations (
      observation_id TEXT PRIMARY KEY REFERENCES pm_observations(id), issue_id TEXT NOT NULL REFERENCES pm_issues(id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS pm_finding_links (
      resource_id TEXT PRIMARY KEY, product_id TEXT NOT NULL, issue_id TEXT NOT NULL REFERENCES pm_issues(id),
      audit_id TEXT NOT NULL, finding_id TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS pm_feedback (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, issue_id TEXT NOT NULL REFERENCES pm_issues(id),
      version INTEGER NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL, data_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(issue_id,version), UNIQUE(issue_id,idempotency_key)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS pm_relations (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, from_id TEXT NOT NULL REFERENCES pm_issues(id),
      to_id TEXT NOT NULL REFERENCES pm_issues(id), kind TEXT NOT NULL, reason TEXT NOT NULL,
      status TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(from_id,to_id,kind)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS pm_todos (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, origin_repo_id TEXT NOT NULL, origin_observation_id TEXT,
      campaign_id TEXT, type TEXT NOT NULL, question TEXT NOT NULL, data_json TEXT NOT NULL,
      status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT, lease_until TEXT, idempotency_key TEXT NOT NULL, digest TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(product_id,idempotency_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS pm_todos_query ON pm_todos(product_id,status,updated_at);
    CREATE TABLE IF NOT EXISTS pm_todo_answers (
      id TEXT PRIMARY KEY, todo_id TEXT NOT NULL REFERENCES pm_todos(id), audit_id TEXT NOT NULL,
      repo_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(todo_id,audit_id,data_json)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS pm_reads (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, audit_id TEXT NOT NULL, task_id TEXT,
      watermark INTEGER NOT NULL, query_json TEXT NOT NULL, result_digest TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS pm_campaigns (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      spec_json TEXT NOT NULL, report_json TEXT, error TEXT, idempotency_key TEXT NOT NULL, digest TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(product_id,idempotency_key)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS pm_jobs (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES pm_campaigns(id), repo_id TEXT, kind TEXT NOT NULL,
      round INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, audit_id TEXT UNIQUE, spec_json TEXT NOT NULL,
      result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS pm_jobs_campaign ON pm_jobs(campaign_id,status,kind);
    CREATE TABLE IF NOT EXISTS pm_candidates (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, campaign_id TEXT NOT NULL, data_json TEXT NOT NULL,
      reviews_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS pm_ingestions (
      source_key TEXT PRIMARY KEY, product_id TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL,
      error TEXT, updated_at TEXT NOT NULL
    ) STRICT;
  `);
}
