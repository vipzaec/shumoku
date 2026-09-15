CREATE TABLE IF NOT EXISTS topology_operator_layout (
  topology_id TEXT PRIMARY KEY REFERENCES topologies(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
