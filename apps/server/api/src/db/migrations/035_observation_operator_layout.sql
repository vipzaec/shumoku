ALTER TABLE topology_observations ADD COLUMN operator_layout_json TEXT;

-- The newest observation predates this migration but represents the current
-- topology state, so seed only that row with the current operator layout.
UPDATE topology_observations AS observation
SET operator_layout_json = (
  SELECT layout.payload_json
  FROM topology_operator_layout AS layout
  WHERE layout.topology_id = observation.topology_id
)
WHERE observation.id = (
  SELECT newest.id
  FROM topology_observations AS newest
  WHERE newest.topology_id = observation.topology_id
  ORDER BY newest.captured_at DESC, newest.rowid DESC
  LIMIT 1
);
