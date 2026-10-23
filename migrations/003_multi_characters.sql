-- A member may control several characters. character_record_id stays the active one;
-- character_ids_json lists every character the member controls.
ALTER TABLE members ADD COLUMN character_ids_json TEXT NOT NULL DEFAULT '[]';
UPDATE members SET character_ids_json = json_array(character_record_id) WHERE character_record_id IS NOT NULL;
