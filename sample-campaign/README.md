# Sample campaigns

The bot ships with two small, original campaign packs. Neither contains any commercial or third-party game text. They use deliberately different rules, so switching between them shows that the bot runs whatever ruleset it is given and does not depend on gameplay code for any particular system.

| Pack | Rules | Adventure | Tracks |
| --- | --- | --- | --- |
| `lanternfall/` | Lanternfall 1.0: d20 + modifier vs DC, armor class, HP, lantern-charge spells with backlash, coins | *The Silent Bell*: a silent flood-bell, a social encounter, a door puzzle, a smuggler fight, and a corrupt Reeve | `hp {current,max}`, `ac`, `coins {gp,sp}`, `lantern {charges,max}` |
| `ashen-oaths/` | Ashen Oaths 1.0: 2d6 + stat, 10+ / 7-9 / 6- outcomes, moves, harm track 0-6, supply, oaths and bonds | *The Kiln at Varrow*: bring a chieftain's son home from a cult relighting an oath-kiln | `harm {current,max}`, `stats {...}`, `supply`, `bonds []` |

Each pack contains:

- `rules.md`, `setting.md`, `adventure.md`: reference material. It is split into chunks at `#` headings and indexed for full-text search. Sections marked **GM Only** hold secrets for the GM. Only the GM model reads reference material; players never see it directly.
- `config.json`: a configuration ready for the owner to review, in the exact `CampaignConfig` shape (`src/types.ts`). It includes the rules digest, setting summary, field conventions, character-creation policy, house rules, precedence, the starting situation, and declarative constraints that `validateConstraintList` accepts.
- `starting-records.json`: a JSON array of `save_turn` operations (only `create` ops using `$ref`s) that seeds the opening locations, the active scene, NPCs (including GM-only secrets in `gm_notes_json` and one record with `gm` visibility), loose items, and an open quest. Every op has all 14 operation keys, unused ones are `null`, and `data_json`/`gm_notes_json` are JSON-encoded strings.

## Importing in Discord

1. In an empty channel, run `/rpg setup` and create the campaign. For `rules_edition`, use `Lanternfall 1.0` or `Ashen Oaths 1.0`.
2. Import each file with its role:
   - `/rpg import` with `rules.md` as **rules**
   - `/rpg import` with `setting.md` as **setting**
   - `/rpg import` with `adventure.md` as **adventure** (keep its visibility GM-only if the import asks, because it contains secrets)
3. Review the proposed configuration and starting state. You can compare it with this pack's `config.json` and `starting-records.json`, or paste their values into it. Then approve the import to activate it.
4. Players create characters with the character command. The GM follows the `character_creation` policy and the field conventions.

To test switching packs, run one pack in one channel and the other pack in a second channel. Campaigns are isolated from each other. Alternatively, archive the first campaign and set up the other pack in the same channel.

## Seeding offline

For tests and evaluations, a campaign can be seeded without calling the model. Store `config.json` as the campaign's `config_json`, load the three Markdown files as approved sources with their roles, and apply `starting-records.json` as one `save_turn` batch. A helper script (for example `npm run seed-sample`) may be added later. Until then, these files are the canonical inputs.

## Spoiler note

The adventure files and some records hold GM-only secrets: the Reeve's bribe in Lanternfall, and Edric's parentage in Ashen Oaths. If you plan to play, don't read `adventure.md`, the `gm_notes_json` fields, or records with `gm` visibility.
