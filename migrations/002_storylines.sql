-- Parallel storylines: each turn records the storyline (active scene record) it was played in.
ALTER TABLE turns ADD COLUMN scene_id TEXT;
CREATE INDEX turns_campaign_scene ON turns (campaign_id, scene_id, id);
