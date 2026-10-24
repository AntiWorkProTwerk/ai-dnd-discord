-- Places the players have seen: their visible layout is canon and only changes for a reason.
CREATE TABLE seen_places (
  campaign_id TEXT NOT NULL,
  place_id TEXT NOT NULL,
  first_turn_id INTEGER,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, place_id)
);

-- Every real (not sketched) place map shown with an earlier play turn counts as seen.
INSERT OR IGNORE INTO seen_places (campaign_id, place_id, first_turn_id, seen_at)
SELECT campaign_id, json_extract(delivery_json, '$.map_snapshot.place_id'), MIN(id), MIN(created_at)
FROM turns
WHERE mode = 'play' AND status IN ('committed', 'delivered')
  AND json_extract(delivery_json, '$.map_snapshot.place_id') IS NOT NULL
  AND IFNULL(json_extract(delivery_json, '$.map_snapshot.sketch'), 0) = 0
GROUP BY campaign_id, json_extract(delivery_json, '$.map_snapshot.place_id');
