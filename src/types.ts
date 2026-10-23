// Shared row and configuration types. Record bodies are campaign-defined JSON; nothing here
// names a gameplay mechanic.

export type CampaignStatus = 'setup' | 'active' | 'paused' | 'archived';
export type Visibility = 'public' | 'owner' | 'gm';
export type SourceRole = 'rules' | 'setting' | 'adventure';

export type TurnMode =
  | 'play'
  | 'ask'
  | 'recap'
  | 'character'
  | 'gm'
  | 'correction'
  | 'undo'
  | 'configure'
  | 'setup'
  | 'import'
  | 'lifecycle'
  | 'summary';

export type TurnStatus =
  | 'queued'
  | 'running'
  | 'committed'
  | 'delivered'
  | 'aborted'
  | 'needs_attention'
  // Draft lifecycle for owner and character proposals.
  | 'proposed'
  | 'awaiting_owner'
  | 'confirmed'
  | 'rejected'
  | 'expired'
  | 'superseded';

export type ConstraintRule = 'required' | 'integer' | 'number' | 'min' | 'max' | 'enum' | 'immutable' | 'lte_field' | 'gte_field';

/** Owner-approved declarative bookkeeping constraint. `kind` "*" applies to every record kind. */
export interface Constraint {
  kind: string;
  path: string;
  rule: ConstraintRule;
  /** min/max: number; enum: string[] (JSON values compared by equality); lte/gte_field: another path. */
  value?: number | string | Array<string | number | boolean> | null;
}

export interface CampaignConfig {
  config_version: number;
  title: string;
  premise: string;
  rules_edition: string;
  tone: string;
  max_players: number;
  boundaries: string;
  require_character_approval: boolean;
  rules_digest: string;
  setting_summary: string;
  /** Field naming conventions the GM must use consistently, e.g. "hp: {current,max}". */
  conventions: string;
  character_creation: string;
  house_rules: string[];
  /** Highest precedence first, e.g. ["house_rules", "rules", "adventure", "setting"]. */
  precedence: string[];
  provisional_ruling_policy: string;
  starting_situation: string;
  constraints: Constraint[];
  model: { reasoning_effort: string | null };
  /** Shared world clock: how far (in-world minutes) one storyline may run ahead of the others. */
  time_sync_window_minutes?: number;
  budget: { monthly_usd: number | null; max_turn_usd: number | null };
}

export interface CampaignRow {
  id: string;
  guild_id: string;
  channel_id: string;
  owner_user_id: string;
  status: CampaignStatus;
  revision: number;
  active_source_version: number;
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface MemberRow {
  campaign_id: string;
  discord_user_id: string;
  /** The active character (used when a command does not name one). */
  character_record_id: string | null;
  /** JSON array of every character this member controls. */
  character_ids_json: string;
  role: 'owner' | 'player';
  created_at: string;
}

export interface RecordRow {
  id: string;
  campaign_id: string;
  kind: string;
  name: string;
  parent_id: string | null;
  visibility: Visibility;
  private_owner_user_id: string | null;
  data_json: string;
  gm_notes_json: string;
  version: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TurnRow {
  id: number;
  campaign_id: string;
  request_id: string;
  actor_user_id: string;
  actor_character_id: string | null;
  mode: TurnMode;
  status: TurnStatus;
  input_text: string;
  base_revision: number | null;
  source_version: number | null;
  rolls_json: string;
  tool_log_json: string;
  changes_json: string | null;
  before_images_json: string | null;
  public_reply: string | null;
  gm_note: string | null;
  usage_json: string;
  delivery_json: string;
  confirm_nonce: string | null;
  expires_at: string | null;
  committed_revision: number | null;
  reverted_by_turn_id: number | null;
  /** Storyline (active scene record) the turn was played in; null outside play. */
  scene_id: string | null;
  attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceRow {
  id: number;
  campaign_id: string;
  import_id: string;
  version: number;
  status: 'pending' | 'approved' | 'rejected' | 'replaced';
  role: SourceRole;
  visibility: 'public' | 'gm';
  title: string;
  filename: string;
  content_hash: string;
  section: string | null;
  page_start: number | null;
  page_end: number | null;
  text: string;
  created_at: string;
}

export interface TurnUsage {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  /** Worst-case allowance still held for a call whose billing is unknown (in flight or timed out). */
  reserved_usd: number;
  provider?: string;
  model?: string;
}

export interface DeliveryState {
  attempts?: number;
  message_ids?: string[];
  /** Interaction webhook token for editing the deferred reply while it is still valid. */
  interaction?: { application_id: string; token: string; created_at: string; ephemeral?: boolean };
  /** Messages are sent to this channel when the interaction has expired. */
  channel_id?: string;
  last_error?: string;
  delivered_at?: string;
  /** Private (ephemeral) output is never re-posted publicly on retry. */
  private?: boolean;
}

/** The actor and permissions that tool handlers receive from the server, never from the model. */
export interface ToolContext {
  campaignId: string;
  turnId: number;
  mode: TurnMode;
  actorUserId: string;
  actorCharacterId: string | null;
  /** GM view sees gm records and gm_notes; player view is filtered. */
  view: 'gm' | 'player';
  /** Owner reviewing imports may search pending sources. */
  includePendingSources: boolean;
  /** Record versions the model has seen this turn (context + read_records), for conflict checks. */
  seen?: Map<string, number>;
  /** Draft modes validate save_turn but store a proposal instead of committing. */
  saveMode: 'commit' | 'draft' | 'none';
  allowDice: boolean;
}
