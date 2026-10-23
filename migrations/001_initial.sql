-- Five logical tables (campaigns, members, records, turns, sources) plus the FTS index.
-- The migration tracker table is created by the runner itself.

CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('setup', 'active', 'paused', 'archived')),
  revision INTEGER NOT NULL DEFAULT 0,
  active_source_version INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- One live campaign per channel.
CREATE UNIQUE INDEX campaigns_channel ON campaigns (guild_id, channel_id) WHERE status <> 'archived';

CREATE TABLE members (
  campaign_id TEXT NOT NULL REFERENCES campaigns (id),
  discord_user_id TEXT NOT NULL,
  character_record_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'player')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, discord_user_id)
);
CREATE UNIQUE INDEX members_character ON members (campaign_id, character_record_id) WHERE character_record_id IS NOT NULL;

CREATE TABLE records (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns (id),
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES records (id),
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'owner', 'gm')),
  private_owner_user_id TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  gm_notes_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX records_campaign_kind ON records (campaign_id, kind);
CREATE INDEX records_campaign_parent ON records (campaign_id, parent_id);
CREATE INDEX records_campaign_name ON records (campaign_id, name COLLATE NOCASE);

CREATE TABLE turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT NOT NULL REFERENCES campaigns (id),
  request_id TEXT NOT NULL UNIQUE,
  actor_user_id TEXT NOT NULL,
  actor_character_id TEXT,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  input_text TEXT NOT NULL DEFAULT '',
  base_revision INTEGER,
  source_version INTEGER,
  rolls_json TEXT NOT NULL DEFAULT '[]',
  tool_log_json TEXT NOT NULL DEFAULT '[]',
  changes_json TEXT,
  before_images_json TEXT,
  public_reply TEXT,
  gm_note TEXT,
  usage_json TEXT NOT NULL DEFAULT '{}',
  delivery_json TEXT NOT NULL DEFAULT '{}',
  -- Implementation details for drafts, confirmations, recovery and undo.
  confirm_nonce TEXT,
  expires_at TEXT,
  committed_revision INTEGER,
  reverted_by_turn_id INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX turns_campaign_status ON turns (campaign_id, status);
CREATE INDEX turns_campaign_mode ON turns (campaign_id, mode, id);
CREATE INDEX turns_created ON turns (created_at);

CREATE TABLE sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT NOT NULL REFERENCES campaigns (id),
  import_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'replaced')),
  role TEXT NOT NULL CHECK (role IN ('rules', 'setting', 'adventure')),
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'gm')),
  title TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  section TEXT,
  page_start INTEGER,
  page_end INTEGER,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX sources_campaign_status ON sources (campaign_id, status, role);
CREATE INDEX sources_import ON sources (import_id);

CREATE VIRTUAL TABLE sources_fts USING fts5 (
  title, section, text,
  content = 'sources', content_rowid = 'id',
  tokenize = 'porter unicode61'
);
CREATE TRIGGER sources_ai AFTER INSERT ON sources BEGIN
  INSERT INTO sources_fts (rowid, title, section, text) VALUES (new.id, new.title, new.section, new.text);
END;
CREATE TRIGGER sources_ad AFTER DELETE ON sources BEGIN
  INSERT INTO sources_fts (sources_fts, rowid, title, section, text) VALUES ('delete', old.id, old.title, old.section, old.text);
END;
CREATE TRIGGER sources_au AFTER UPDATE OF title, section, text ON sources BEGIN
  INSERT INTO sources_fts (sources_fts, rowid, title, section, text) VALUES ('delete', old.id, old.title, old.section, old.text);
  INSERT INTO sources_fts (rowid, title, section, text) VALUES (new.id, new.title, new.section, new.text);
END;
