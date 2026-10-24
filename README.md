# Discord AI game master

A Discord bot that runs a text tabletop campaign in a channel. One LLM acts as the game master (GM): it reads campaign records, searches the rules and setting you imported, rolls dice through a tool, and saves changes to a SQLite database.

There is no RPG engine. Characters, NPCs, items, locations, quests, scenes, buildings and events are all generic records (`kind`, `name`, `parent_id`, JSON `data`, GM-only notes). The model handles rules, combat, crafting, travel and so on by reading and changing those records through four tools: `read_records`, `search_reference`, `roll_dice` and `save_turn`. The application enforces campaign isolation, Discord identity, owner permissions, transactions, bounded inputs, optional owner-approved field constraints and spending limits. Whether a ruling follows the rules is the model's job, and the application does not check it.

Design details are in [IMPLEMENTATION_SPEC.md](IMPLEMENTATION_SPEC.md). The GM instructions are in [src/prompts/gm.md](src/prompts/gm.md).

## Requirements

- Node.js **>= 22.13** (`engines` in package.json). Tested on Node 24.20 on Windows.
- npm (comes with Node). `better-sqlite3` ships prebuilt binaries for common platforms, so a C++ toolchain is normally not needed.
- A Discord account that can create applications, and a server where you can invite bots.
- One of:
  - an OpenAI API key (default model `gpt-6-luna` via the Responses API), or
  - a local [Ollama](https://ollama.com) install with a model that supports tool calling.
- A machine that stays on, with a persistent local disk for `DATA_DIR`.

## Quick start: play locally in the terminal (no Discord)

```sh
npm ci
npm run local                      # Lanternfall sample campaign, you are the owner
npm run local -- --pack ashen-oaths --fresh   # different rules pack, wipe the local save
```

This uses the same engine, records, dice, budgets and owner tools as the bot, with replies printed to the terminal. It needs `OPENAI_API_KEY` (or `LLM_PROVIDER=ollama`) in your environment or `.env`. The save lives in `data/local/` and persists between runs. Type `help` for commands. Anything without a command word is a play action. Use `as bob` to act as another player. Press numbered buttons by typing the number.

## 1. Create the Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. **General Information**: copy the **Application ID**. This is `DISCORD_APPLICATION_ID`, and it is also the `CLIENT_ID` in the invite URL below.
3. **Bot** tab: click **Reset Token** and copy the token into `DISCORD_TOKEN`. Treat it like a password. If it leaks, reset it.
4. **Privileged Gateway Intents**: leave all three off (Presence, Server Members, Message Content). The bot only uses the `Guilds` intent and slash commands. It never reads ordinary channel messages.
5. You can turn off **Public Bot** if only you should be able to invite it.

### Invite with minimum permissions

Scopes: `bot applications.commands`

Bot permissions:

| Permission | Value | Why |
|---|---|---|
| View Channels | 1024 | See the campaign channel |
| Send Messages | 2048 | Public notices, and public replies when an interaction token has expired |
| Embed Links | 16384 | Link previews in channel posts |
| Attach Files | 32768 | Scene illustrations and long configuration drafts (`configuration-draft.md`) |
| Create Public Threads | 34359738368 | A thread for each side storyline |
| Create Private Threads | 68719476736 | Private side storylines (`/rpg play private:true`) |
| Send Messages in Threads | 274877906944 | Posting in storyline threads |

Total: `1024 + 2048 + 16384 + 32768 + 34359738368 + 68719476736 + 274877906944 = 377957174272`

```text
https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot+applications.commands&permissions=377957174272
```

If the bot is already in your server, either open this link again to update its permissions, or add the two thread permissions to the bot's role.

Replace `CLIENT_ID` with your Application ID and open the URL.

Not needed:
- **Embed Links**. Replies are plain message content.
- **Read Message History**. Slash commands do not need it.
- **Mention Everyone**. All mentions are disabled on every send and edit.

**Do not grant Administrator.** The bot does not need it, and a leaked token would then control your whole server.

If a channel has permission overrides, make sure the bot's role can still view and send there.

## 2. Install and configure

```sh
npm ci
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
```

Edit `.env`. Every variable is documented in [.env.example](.env.example). Values already set in the real environment take precedence over `.env`. Never commit `.env`. It is already in `.gitignore`.

### Discord

```env
DISCORD_TOKEN=...               # Bot tab
DISCORD_APPLICATION_ID=...      # General Information tab
DISCORD_GUILD_ID=               # optional: your server ID, for instant command registration
BOT_ADMIN_USER_IDS=             # optional: comma-separated user IDs allowed to run /rpg setup anywhere
```

To copy server or user IDs, turn on Developer Mode in Discord (User Settings → Advanced) and right-click.

### Model provider: OpenAI (default)

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-6-luna
OPENAI_REASONING_EFFORT=low
OPENAI_INPUT_USD_PER_MILLION=0.10
OPENAI_OUTPUT_USD_PER_MILLION=0.50
```

The two price variables drive all budget arithmetic. The defaults are the short-context `gpt-6-luna` rates that applied when this project was written. **Check OpenAI's pricing page and update them before you rely on the budget limits.** If they are set too low, the bot will underestimate spend. `OPENAI_BASE_URL` is optional and points the client at an OpenAI-compatible endpoint.

### Model provider: Ollama (local)

```env
LLM_PROVIDER=ollama
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:8b
OLLAMA_NUM_CTX=16384
```

Pull the model first (`ollama pull qwen3:8b`). It must support tool calling. Ollama uses the same tools, records and limits as OpenAI. Dollar budgets do not apply because local calls are recorded as $0, but the call, tool, token and timeout limits still apply. **Local models have not been tested against Luna's quality here.** Expect more malformed tool calls, more failed turns and weaker rulings, especially from small models.

### Check the setup

```sh
npm run doctor
```

The doctor checks the Node version, configuration, that the data directory is writable, SQLite FTS5, migrations and `integrity_check`, the GM prompt file, whether the Discord settings are present (values are never printed), budget sanity, and the provider. The provider check is free: OpenAI retrieves the model, and Ollama lists pulled models. It also reports whether a running bot holds the instance lock. It exits with code 1 if any check fails.

### Register the slash command

```sh
npm run register
```

- With `DISCORD_GUILD_ID` set, `/rpg` is registered to that one server and appears immediately. This is best for a private group and for testing.
- With it blank, `/rpg` is registered globally and can take up to an hour to appear.

Run this again after updating the bot if the command definitions changed. The command can only be used in server channels, not DMs.

The database is created and migrated automatically when the bot or any script opens it. `npm run migrate` applies migrations explicitly and lists them.

## 3. Run the bot

Pick one:

```sh
# Foreground, straight from TypeScript (tsx). Ctrl+C stops it cleanly.
npm run dev

# Compiled
npm run build
npm start                  # node dist/src/index.js
```

**Docker Compose** (one container, named volume for `/app/data`):

```sh
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml run --rm bot node dist/scripts/doctor.js
docker compose -f deploy/docker-compose.yml run --rm bot node dist/scripts/register-commands.js
docker compose -f deploy/docker-compose.yml exec bot node dist/scripts/backup.js
```

Compose reads `../.env`. To use Ollama on the host, uncomment the `OLLAMA_URL` / `extra_hosts` lines in [deploy/docker-compose.yml](deploy/docker-compose.yml).

**systemd** (Linux, no container): see the install steps at the top of [deploy/rpg-bot.service](deploy/rpg-bot.service). The unit keeps data in `/var/lib/rpg-bot` and runs as a dedicated user.

Operating notes:

- **One process per data directory.** The bot takes a lock file (`DATA_DIR/rpg.lock`) and refuses to start if another live process holds it. Do not scale the container or run two copies against the same database.
- **Persistent disk.** `DATA_DIR` holds the SQLite database, imported originals and backups. Do not put it on an ephemeral container filesystem or a network share.
- **Keep the host awake.** On a laptop or desktop, turn off sleep and hibernate while the campaign is running, or the bot stops responding. On Windows, set Power & battery → Screen and sleep → "Never" for sleep while plugged in.
- **Shutdown.** SIGINT/SIGTERM (Ctrl+C, `docker stop`, `systemctl stop`) stops accepting new requests and waits up to 30 seconds for active turns before closing. Anything left over is handled by recovery at the next start (see [Inspecting failures](#7-inspecting-failures)).
- Logs go to stdout/stderr (`LOG_LEVEL=debug|info|warn|error`). Known secrets are redacted.

## 4. Running a campaign

### Sample material

[sample-campaign/](sample-campaign/) contains two small original rules/setting/adventure packs. See [sample-campaign/README.md](sample-campaign/README.md).

- `lanternfall/`: Lanternfall 1.0, a light d20 game in a flooded marsh country.
- `ashen-oaths/`: Ashen Oaths, a 2d6 game with a harm track and shared supply instead of HP and coins.

Both use the same code. Switching rules is a matter of what you import and approve.

### Typical flow

1. **Owner: `/rpg setup`** in the channel that will host the game. Options: `title`, `rules_edition` (for example `Lanternfall 1.0`), `premise`, `tone`, `max_players` (default 4), `boundaries`, `approve_characters`. You need **Manage Channels** in that channel, or your user ID must be in `BOT_ADMIN_USER_IDS`. Whoever runs setup becomes the campaign owner. One active campaign per channel. Different channels are fully separate campaigns.
2. **Owner: `/rpg import`** with an `attachment` and a `role` (`rules`, `setting` or `adventure`). Accepted files are `.md`, `.txt`, and PDFs with a text layer, up to `MAX_IMPORT_MB`. You get a private preview with page and character counts and warnings, such as pages with no text layer, which are not imported. Click **Approve import** or **Reject**. The import stays private and unsearchable until approved. Adventure material is stored as GM-only. The original file is kept under `DATA_DIR/sources/` with its SHA-256, and identical re-imports are refused.
   - After the **first** approval, while the campaign still has no rules digest, the bot automatically asks the model to draft a configuration: rules digest, setting summary, field conventions, character-creation procedure, optional constraints and a small starting situation. The draft appears privately for review, with an attached `.md` file if it is long. Click **Apply configuration** or **Discard**. This draft is a paid model call and counts against the budget.
   - Importing the sample pack: import `rules.md` as rules, `setting.md` as setting, and `adventure.md` as adventure.
   - Or seed a sample pack offline, with the bot stopped. This runs the same import, approval and record paths and applies the pack's reviewed `config.json` and `starting-records.json`:
     `npm run seed-sample -- --guild <guild id> --channel <channel id> --owner <your user id> --pack lanternfall` (or `--pack ashen-oaths`). Add `--replace` to archive the campaign already in that channel first (its data is kept).
3. **Owner: `/rpg configure text:...`** drafts any later change ("add a house rule: ...", "require owner approval for characters", "quantity must be a non-negative integer"). It shows a before/after preview, any new starting records, and questions the model has. Nothing changes until you click **Apply configuration**. A draft is refused if the configuration changed since it was drafted, or if existing records would violate a new constraint. Constraints are never applied by silently clamping values.
4. **Players: `/rpg character text:...`** Character creation can take several exchanges. The model follows the campaign's creation rules and asks questions as needed. When it proposes a sheet, the player sees the proposed records with **Accept character** / **Discard** buttons. If the owner turned on character approval (`approve_characters` at setup, or through `/rpg configure`), accepting posts the draft in the channel with **Approve (owner)** / **Reject (owner)** buttons. The owner's own character skips this. The new character is always bound to the Discord user who made the draft. The model cannot choose that mapping. Each user gets one character per campaign, up to `max_players`.
5. **Owner: `/rpg start`**. Players can create characters before or after this.
6. **Play:** `/rpg play text:...` for any in-fiction action or speech. `/rpg ask` for rules or world questions that change nothing. `/rpg sheet` to see your sheet and inventory. `/rpg recap` for the story so far.

Turns are processed one at a time per campaign, in order. Up to `MAX_QUEUED_TURNS_PER_CAMPAIGN` requests can wait. Beyond that, a request is refused with a private message. A play reply shows the action, the narration, and small receipts generated from the accepted dice and record changes (not from the narration).

Confirmation buttons expire after `CONFIRMATION_TTL_MINUTES` (corrections, undo). Import, configuration and character drafts get 4× that, and owner approval of a character gets 8×. Each button works once, is checked again on click, and only works for the right user.

### Command reference

"Private" means an ephemeral reply only the caller sees.

| Command | Who | Output | Model call? | What it does |
|---|---|---|---|---|
| `/rpg setup` | Manage Channels or `BOT_ADMIN_USER_IDS` | Private | No | Create a campaign in this channel; caller becomes owner |
| `/rpg import` | Owner | Private | No (approval may trigger a config draft) | Upload rules/setting/adventure for review |
| `/rpg configure` | Owner | Private | Yes | Draft a configuration change for review |
| `/rpg start` / `pause` / `resume` | Owner | Private acknowledgement + public notice | No | Campaign lifecycle. `play` only works while active |
| `/rpg character` | Any member without a character; the owner can create several | Private (owner approval request is public) | Yes | Conversational character creation |
| `/rpg play` | Players with a character | **Public** | Yes | Main game action. `as:` picks which of your characters acts |
| `/rpg ask` | Anyone in the channel | Private | Yes | Read-only question. No dice, no writes, player-visible data only |
| `/rpg sheet` | Players | Private | No | Your sheet and inventory from the database, without GM notes. `as:` picks the character |
| `/rpg look` | Players | Private | No | Where your character is: ways out (named once the party has been there), what is around you and who is in view, with distances, and what is publicly known about the area. Also the **👀 Look around** button under every reply. `as:` picks the character |
| `/rpg map` | Players | Public map, private acknowledgement | No | Map of the place your character is in (`as:` picks the character) |
| `/rpg merge` | Players in that storyline, owner | Public announcement, private acknowledgement | No | Run in a side thread: the thread closes and that storyline becomes the main story in the main channel |
| `/rpg portrait` | Players | Private | No (local image) | Your character's reference portrait; `regenerate:true` paints a new one |
| `/rpg diorama` | Players | Public | No (local Blender) | Your place as a 3D diorama; `turntable:true` for a rotating video |
| `/rpg recap` | Anyone in the channel | **Public** | Only if the cached recap is stale | Recap from saved events |
| `/rpg gm` | Owner | Private preview; public announcement on apply | Yes | Correction, clarification or world advance |
| `/rpg undo` | Owner | Private preview; public announcement on apply | No | Revert the latest world turn |
| `/rpg usage` | Owner | Private | No | Spend, tokens, budget, recent failures |
| `/rpg backup` | Owner | Private | No | Write a backup on the bot host |

"Owner" means the campaign owner (the user who ran `/rpg setup`). `BOT_ADMIN_USER_IDS` only lets someone create campaigns. It does not give them owner rights over other people's campaigns.

### Parallel storylines (several players doing different things at once)

Players don't have to stay together. Each **storyline** is an ordinary active `scene` record whose `participants_ids` lists the characters in it, and different storylines are played **at the same time**, like a live MMO.

- **The main story** lives in the campaign channel. When a character goes off somewhere else ("I leave the inn and ride for the marshes"), the GM starts a new storyline for them automatically, so it gets its own turn order and runs at the same time as the others. Its replies keep posting in the channel under their own header (`📍 Into the Rain-Reed Wilds`).
- **Side threads are the players' choice.** Each reply of a side storyline that is still in the main channel has a **🧵 Side thread** button. The storyline's players or the owner can press it to move that storyline into its own public thread. `/rpg play side:true` does it straight away. Anyone whose character goes to that place joins the storyline and is added to its thread. When they come back, the thread closes and the story continues in the channel.
- **Private threads are one-on-one with the DM.** `/rpg play private:true` whispers an action: a thought, a secret question, or something done quietly. The answer goes to your own private thread with the DM, created on first use. Only you can see it (plus server moderators, as with any private thread). Anything you play inside that thread is a whisper too. A whisper doesn't move your character out of their storyline, and other players' GM context never includes it. Actions others would plainly notice have to be played openly.
- **Threads never disappear.** They auto-archive after 7 days of quiet, stay readable, and reopen when posted to. When a storyline ends or rejoins another (characters meet, someone joins the fight), its thread gets a closing line and is archived.
- **Live and consistent at the same time:**
  - Actions in one storyline resolve in order, because turn order matters there. Different storylines resolve concurrently.
  - Conflicts are checked per record. If two storylines change the same NPC at the same moment, the second save is rejected, and the GM re-reads and retries with the same dice. Nothing is overwritten.
  - A character can be in only one active storyline. The GM sees its own storyline in full and the others as read-only context, so facts stay consistent across them.
- **Turn order is enforced by the server.** In the acting player's fight, a save may not end with an NPC's turn pending, or skip the NPCs after a player used their turn. The GM must play those NPC turns in the same reply. Characters who aren't in a fight are never blocked by its turn order.
- **Shared world clock:**
  - Every scene keeps `time_min` (in-world minutes since Day 1, 00:00). A storyline may run at most `time_sync_window_minutes` ahead of the slowest active storyline. The default is 60; change it with `/rpg configure`.
  - Longer actions (a three-day journey) are narrated as under way (`busy_until_min`). When the rest of the world catches up, the bot posts "⏳ … can now finish" in that storyline.
  - Storylines idle for 30 real minutes don't hold the clock back. The owner can move the world forward with `/rpg gm text: advance the world to dawn`.
- **Testing it alone:** the campaign owner can control several characters. Each `/rpg character` conversation creates another one (names must be unique), then act as each one with `/rpg play as:<name> text: …` (the `as` box autocompletes your characters). The character you pick stays your active one until you pick another. Other players still control one character each, and nobody can act as a character they don't control.
- Each GM reply starts with a small storyline header, for example `📍 Brawl at the Tallow and Tide · round 2 · Day 1, 18:40`.

### World maps (free, exact, no AI)

The whole game world is mapped and saved, so it stays consistent: distances are exact, "I walk over to the fireplace" moves you to real cells, and a place looks the same whenever anyone comes back.
- **Every place is a location with its own grid map** (`data.map`: `{cols, rows, cell_ft, features: [{kind, label, x, y, w, h, to}]}`). Feature kinds are wall, door, cover, difficult, water, pit, object, stairs, light and exit. Doors, stairs and exits carry `to`: the place they lead to.
- **Everyone has a saved position** (`data.pos {x, y, size}` on each character and npc) on the map of the place they are in. NPCs stay where they were left.
- **New places are made when someone goes there**, or ahead of time in the background (below). The first time anyone goes somewhere unmapped (out the back door, down an alley), the GM must create that place and its map in the same move, linked back to where they came from. A whole town is never one map: the GM makes the specific street or room inside it.
- **Long trips** (another town, days away) use the shared world clock instead of the grid, and put you at the destination's entrance.

The GM sees a text version of the current place's map (positions, distances, exits and where they lead, who still needs a spot) and the places nearby.

The server checks every save:
- a play turn's place has a map, and everyone in it a position;
- positions are inside the grid, one creature per cell, nobody inside a wall or object;
- a move within a place has an open path around walls; in a fight it is at most a dash (twice the creature's speed);
- attacks must reach their target;
- a new place someone walked into links back to where they came from.

Hidden creatures (`gm_notes.pos`) and secret terrain (the location's `gm_notes.map_features`) are never drawn. Battle maps saved on scenes by older versions move to their place automatically at startup.

### What exists: the GM decides, players add small things

As at a real table, the GM owns the world and players explore it. When a player's words assume something ("I go to the nearest fur trader"), the GM answers from what is recorded:
- **Settled:** it is there, or it is not, and the GM says what is there instead.
- **Unsettled and small:** yes, often with a twist (a fur stall that is closed for the night). It is saved, so it stays true.
- **Unsettled and big:** no, or earn it ("the Reeve is my uncle" gets you a look from the guards, not the key).

Three layers keep this consistent:
- **Town outlines.** Every town, village or district gets a short public list of what is there and what it lacks (`data.notable`: "ferry dock", "tanner (buys pelts)", "no smith"), with secrets in its GM notes. The GM sees it every turn; players see it with 👀 Look around.
- **Unknown until seen.** The server records every place a player character has been in. A save that removes, moves or relabels something on a seen map, or shrinks it, is rejected unless the GM gives a reason in the world (`world_change`: "the fire burned the stable down"). Additions are fine, as are linking a door that led nowhere and claiming an **open** feature: maps leave room for later, such as a shuttered shopfront that can turn out to be the fur trader.
- **Background preparation** (`WORLD_PREP=on`, default). After each action, the server looks around the actor's place for:
  - a town with no outline;
  - a door or exit leading to a place with no map;
  - a named door or exit leading nowhere yet.

  It then runs one small GM job in the background to prepare them: map, people, secrets, links both ways. Players are never kept waiting and nothing is posted. Prep cannot touch characters or scenes, roll dice or change what players have seen. It runs one job at a time per campaign, never repeats the same tasks, and is charged to the campaign budget.

To see the map (a top-down tactical grid with tokens, name labels, a legend, wounded and down markers, and a gold ring for whose turn it is):
- `/rpg play map:true text: …` posts the map right after the reply.
- The **🗺️ Map** button under a reply shows the map as it was at that moment.
- `/rpg map` (optional `as:`) posts your storyline's current map, in its thread for side stories.

With `DIORAMA=on` the map is drawn over a top-down Blender render of the scene (see below), so you see the room, furniture and figures from above. The grid, colored token rings, names and markers are drawn on top by the bot, so they stay crisp. If Blender fails or the GPU queue is full, you get the flat map instead. Without `DIORAMA=on`, the flat map is always used.

### One 3D scene, three views (optional, free)

With `DIORAMA=on`, your local Blender (`BLENDER_PATH`, or the path in the 3D pipeline's config) builds **one 3D scene** of the moment from the public game state: walls, floor and furniture from the battle map and the location, and a figure, or the character's saved 3D miniature, where each token stands. The 🗺️ map, the 🧊 diorama and the 🎨 picture are all renders of that same scene, from different cameras:
- **🗺️ Map:** flat, evenly lit, straight down, with the overlays above.
- **🧊 Diorama:** a raised 3/4 view with a grid on the floor. `turntable:true` posts a short rotating video instead of a still.
- **🎨 Picture:** the cinematic shot (see "Rendered 3D scenes" below).

Positions are exact and no AI is involved, so there are no extra hands. Fallen figures lie down, and people who joined mid-round are drawn faded.

To see a diorama:
- **🧊 Diorama** under a reply (shown when the reply has a battle map) builds that moment.
- `/rpg play diorama:true` builds it automatically after the reply.
- `/rpg diorama` (optional `as:`) builds the current scene. `turntable:true` posts a short rotating video instead of a still.

**3D miniatures.** With both image generation and `DIORAMA=on`, each player character's portrait is turned into a textured 3D miniature by the local 3D pipeline (`scripts/miniature.py` runs its pinned Pixal3D image-to-model graph). It takes about a minute, happens automatically after a new character's portrait, and is stored at `DATA_DIR/images/<campaign>/miniatures/`. The scene then shows the miniature instead of a plain figure. Use `/rpg portrait miniature:true` to build one for an existing character, and add `regenerate:true` to rebuild it. A miniature is rebuilt when the portrait changes. Maps and dioramas use the miniatures that already exist and never wait to build one; the 🎨 picture builds missing ones for the people in focus first.

All 3D renders share the painting queue and the pipeline's GPU lock, so only one heavy job runs at a time. ComfyUI's models are unloaded first when it is idle.

Discord has no native 3D model viewer. An interactive 3D view would need a Discord Activity (an embedded web app on a public HTTPS host), which isn't built.

### Rendered 3D scenes (🎨, default)

With `IMAGE_GENERATION=comfy` and `DIORAMA=on`, the 🎨 Illustrate button and `illustrate:true` render the moment as a **3D scene in Blender** instead of painting it:
- **People:** the saved 3D miniatures stand where the battle map puts them, turned toward their opponent. Fallen characters lie on the ground.
- **Room:** walls, floor and furniture are built from the map and the location's description (wood or stone, bar counter, tables, barrels, hearth…). The walls between the camera and the action are cut away.
- **Light:** follows the scene's time of day and weather.
- **Camera:** a cinematic view from behind the acting character toward the people in focus.

It's the same models every time, with no AI image artifacts. Scenes without a battle map get a small made-up layout.

The first time a character or NPC is in focus, their portrait and miniature are built first, about a minute each; after that they're reused. If Blender fails, the bot paints the picture instead. Set `IMAGE_MODE=paint` to always use the FLUX paintings described below.

### Scene illustrations (optional, free)

With `IMAGE_GENERATION=comfy`, every GM reply in the channel gets a **🎨 Illustrate** button, and `/rpg play` takes an optional `illustrate:true` that paints the scene automatically. Anyone at the table can press the button. The picture is posted as a reply to the scene it shows and saved under `DATA_DIR/images/`. Images never change the game.

Generation runs entirely on your own GPU through the local 2D asset workshop (`IMAGE_PIPELINE_ROOT`, default `D:/Godot/local-2d-pipeline`). `scripts/comfy_image.py` is run with the workshop's own Python and reuses the workshop's code:
- the shared GPU lock,
- the offline ComfyUI launcher (API and custom nodes disabled),
- the pinned FLUX.2 Klein text-to-image graph,
- the audited node allowlist.

No paid or remote model is used, and the image prompt is built without any model call. On this machine the first image after ComfyUI starts took about 70 seconds; later ones took about 5 seconds at 1024×576.

- **Spoiler safety:** prompts use only the public narration, the acting character's public look and the public location. GM notes and hidden records are never read. Quoted dialogue and known names are left out, because FLUX tends to paint them as garbled lettering.
- **One at a time:** images are queued one at a time, with a backlog of `IMAGE_MAX_QUEUE`. If another pipeline job (3D, Blender, 2D) holds the GPU lock, the bot retries for about 45 seconds, then posts "the GPU is busy" and the button can be pressed again later.
- **Local only:** this only works on the machine that has the pipeline. Everywhere else, leave `IMAGE_GENERATION=off` and the button is hidden.

**Consistent characters (portraits).**
- **When portraits are painted:** every character gets a full-body portrait once, in the background, when it is accepted. A missing one is painted the first time the character appears in an illustration.
- **What a portrait is built from:** the sheet's public `appearance` and gear. The GM now always records `appearance` (sex, age, build, hair, face, clothing) for new characters. For an older character, add one with `/rpg gm text: give Thaniesh an appearance: a lean male night elf with a dark braid…`.
- **Where they are stored:** `DATA_DIR/images/<campaign>/portraits/`. A portrait is repainted when the appearance or gear changes, or when the file is missing (backups don't include images).
- **Viewing one:** `/rpg portrait` (optional `as:`) shows yours; `regenerate:true` paints a new one.

**How 🎨 Illustrate uses portraits and the map.**
- **Focus:** at most three people: the actor, whose turn it is, then those named or nearest on the battle map. Everyone else is a background figure.
- **References:** up to two player-character portraits are passed to FLUX.2 as reference images, so faces and outfits stay the same from picture to picture. With more references, the model started swapping features between people.
- **Positions:** where people stand comes from the battle map, written as text (foreground or background, left or right, next to whom, by the bar). In tests, a guide image with colored or grey figures leaked into the painting.
- **Fallback:** if the reference run fails, the picture is painted from text alone.
- **Turning it off:** set `IMAGE_REFERENCES=off` to go back to text-only pictures.

## 5. Owner tools

### Corrections: `/rpg gm text:...`

Use this for "Mira should have 7 HP, not 3", "the bridge collapsed overnight", "move the party to the inn" or "advance time to dawn". The model drafts record changes and a public announcement. You see a private preview with the diff (hidden/GM-only fields are marked 🔒), the stated reason and the announcement text, plus **Apply change** / **Cancel**.

On apply, the change is written in one transaction as a `correction` turn. Only the announcement is posted publicly, and it is meant to contain no hidden facts. Check it in the preview, because the model writes it. The change is refused if the world changed after it was drafted (the campaign revision moved), so it cannot overwrite newer facts. Draft it again in that case. `/rpg gm` is also how you resolve a turn that is `needs_attention`.

### Undo: `/rpg undo`

This targets only the **latest** committed `play` or `correction` turn that has not already been reverted. The preview lists each field and what it reverts to. It is refused if any record it touched has changed since, so it cannot overwrite later changes. On apply, the original records are restored from stored before-images, and a new `undo` turn is recorded and announced publicly. The original turn, its dice and its cost stay in the log. Undo does not replay the action. Rolling back further than the latest turn is a backup/restore job.

### Usage: `/rpg usage`

Shows, for the current UTC calendar month: model calls, requests, input/output tokens, spend, money still held for in-flight or uncertain calls, the campaign budget and how much remains, the per-request ceiling, bot-wide spend (if `GLOBAL_MONTHLY_BUDGET_USD` is set), and the **five most recent failed turns** (`aborted` or `needs_attention`) with their error text.

### Pause/resume: `/rpg pause`, `/rpg resume`

While paused, `/rpg play` is refused. A `play` turn that was already queued is aborted with a notice and does not run. Other commands keep working.

## 6. Budgets and limits

All limits come from `.env`. Defaults are starting values, not performance promises.

| Variable | Default | Meaning |
|---|---|---|
| `MAX_MODEL_CALLS_PER_TURN` | 8 | Model API requests one request may make (read → roll → save is often 2–4) |
| `MAX_TOOL_CALLS_PER_TURN` | 24 | Tool calls across those requests |
| `MAX_INPUT_TOKENS_PER_CALL` | 16000 | Estimated input size cap per call. The turn fails rather than send more |
| `MAX_OUTPUT_TOKENS_PER_CALL` | 4096 | Output cap per call. Also used in the worst-case reservation |
| `TURN_TIMEOUT_SECONDS` | 90 | Wall-clock limit for one request's model loop |
| `CAMPAIGN_MONTHLY_BUDGET_USD` | 5 | Spend per campaign per UTC calendar month. `0` refuses all paid turns |
| `MAX_TURN_COST_USD` | 0.02 | Ceiling for one player request (`play`, `ask`, `character`, `recap`, summaries) |
| `MAX_ADMIN_TURN_COST_USD` | 0.05 | Ceiling for one owner request (`gm`, `configure`, including the post-import configuration draft) |
| `GLOBAL_MONTHLY_BUDGET_USD` | 0 | Bot-wide monthly ceiling across all campaigns. `0` = no extra ceiling |
| `MAX_CONCURRENT_MODEL_TURNS` | 2 | Model calls in flight across all campaigns |
| `MAX_QUEUED_TURNS_PER_CAMPAIGN` | 5 | Queued + running requests per campaign before new ones are refused |
| `MAX_IMPORT_MB` | 20 | Largest import file |
| `CONFIRMATION_TTL_MINUTES` | 15 | Base lifetime of confirmation buttons (see above) |

How spending is controlled (paid provider only):

- **Before every model call** the bot reserves that call's worst-case cost: estimated input tokens × input price + `MAX_OUTPUT_TOKENS_PER_CALL` × output price. The reservation is written to the turn before the request is sent, so a crash still counts it. The call goes ahead only if all three checks pass: campaign month spend + held reservations + this call ≤ campaign budget; the same for the bot-wide budget (if set); and this request's own spend + this call ≤ the per-request ceiling.
- After the call, the reservation is replaced by the actual cost from the reported token usage. If the call failed in a way that may still have been billed (timeout, connection loss, server error), the worst case is kept as spent. Outright rejections release it. Reservations still held when the process died are counted as spent at the next start.
- Example with default prices: a full 16k-token input plus 4096 output tokens costs about $0.0016 + $0.0020 ≈ $0.0036, so `MAX_TURN_COST_USD=0.02` allows about five maximum-size calls. Smaller contexts reserve less.
- **When a budget is exhausted, no new paid call starts.** This covers player turns, `/rpg ask`, character drafts, non-cached recaps, background history summaries, `/rpg gm` and `/rpg configure` drafts, the automatic configuration draft after an import, and resumed or retried turns. New requests are refused up front with a private message once the campaign's month is used up. A request that hits a ceiling partway through fails with "Nothing in the world changed".
- **No automatic model or provider switching.** When the budget runs out, the bot stops making calls. Raise the budget in `.env` and restart, or wait for the next month.
- These limits count only this bot's own calls under your configured prices. They do not see other applications using the same API key. Set a hard limit in your OpenAI account as well.

## 7. Inspecting failures

Start with `/rpg usage`. It lists the five most recent `aborted` / `needs_attention` turns and their errors.

The bot also writes a daily log file, `DATA_DIR/logs/bot-YYYY-MM-DD.log`, kept for 14 days. It records:
- every command and button press (Discord user ID, name and text),
- every turn's outcome (status, model calls, cost, seconds, error),
- every image (time, file and prompt),
- delivery problems.

Lines are redacted like the console, so the bot token and API key are never written. Player text is included, so treat the logs as private.

For more detail, open the database. Every request is a row in `turns`.

### Turn statuses

| Status | Meaning |
|---|---|
| `queued` | Accepted, waiting for its campaign's queue |
| `running` | Model loop in progress |
| `committed` | World change (or read-only answer) saved; reply not yet fully delivered |
| `delivered` | Reply sent (or a private reply could no longer be sent; see `delivery_json`) |
| `aborted` | Failed or refused before commit (budget, queue full, model error, paused). Nothing in the world changed |
| `needs_attention` | The owner needs to act. Either a play turn failed after dice were rolled, a turn was interrupted twice, or delivery failed 10 times |

Draft and confirmation rows also use `proposed`, `awaiting_owner`, `confirmed`, `rejected`, `expired` and `superseded`.

### What happens on failure and at restart

- A model error or timeout **before commit** changes no records. Dice already rolled stay in `rolls_json`. A `play` or `gm` turn that rolled dice is retried **once** with the same saved checks. If it fails again, a play turn becomes `needs_attention` and the player is told the dice are kept and the owner will resolve it with `/rpg gm`. The bot never silently re-runs an action with fresh dice.
- **After commit**, a delivery failure only resends the stored reply. The action is never run again. Undelivered committed turns are retried at startup and every 30 seconds. After 10 failed attempts the turn becomes `needs_attention`.
- **At startup**, recovery: counts any reservations left by `running` turns as spent; puts interrupted turns back in the queue once (they resume with their saved checks); marks turns interrupted a second time as `needs_attention` and posts a notice; aborts interrupted imports and undos; expires stale drafts; re-runs `queued` turns; and retries undelivered replies.

### Useful columns

- `status`, `error`: outcome and reason.
- `mode`: `play`, `ask`, `recap`, `character`, `gm`, `correction`, `undo`, `configure`, `import`, `lifecycle`, `summary`.
- `input_text`: what the player or owner typed.
- `tool_log_json`: each model call's tool calls with arguments and outputs, plus final text and provider errors (the last 80 entries, clipped).
- `rolls_json`: declared checks and their results.
- `changes_json`, `before_images_json`: accepted operations and diffs, and the record states used by undo.
- `public_reply`, `gm_note`: the stored narration and the model's short ruling note.
- `usage_json`: `calls`, `input_tokens`, `output_tokens`, `cost_usd`, `reserved_usd`, `provider`, `model`.
- `delivery_json`: target channel, sent `message_ids`, `attempts`, `last_error`, `delivered_at`.

### Example queries

The `sqlite3` command-line tool is not bundled. Install it separately, or use any SQLite browser. Open the database read-only while the bot runs:

```sh
sqlite3 -readonly data/rpg.sqlite
```

```sql
-- Recent problems in all campaigns
SELECT id, campaign_id, mode, status, error, created_at
FROM turns WHERE status IN ('aborted', 'needs_attention')
ORDER BY id DESC LIMIT 20;

-- What the model did on one turn
SELECT input_text, tool_log_json, rolls_json, gm_note FROM turns WHERE id = 123;

-- Replies stuck in delivery
SELECT id, json_extract(delivery_json, '$.attempts') AS attempts,
       json_extract(delivery_json, '$.last_error') AS last_error
FROM turns WHERE status = 'committed';

-- Most expensive requests this month
SELECT id, mode, json_extract(usage_json, '$.calls') AS calls,
       json_extract(usage_json, '$.cost_usd') AS cost
FROM turns WHERE created_at >= strftime('%Y-%m-01', 'now')
ORDER BY cost DESC LIMIT 10;
```

Do not edit the database by hand while the bot runs. Use `/rpg gm` for world corrections.

## 8. Backup and restore

**Create a backup** with `/rpg backup` (owner, private reply with the ID) or from the host:

```sh
npm run backup
```

This writes `DATA_DIR/backups/<id>/` containing `rpg.sqlite`, made with SQLite's online backup API (safe while the bot runs), the imported source originals, and `manifest.json` with checksums, schema version and table counts. The backup copy passes `integrity_check` before it is reported. `.env`, the Discord token and API keys are never included. A backup contains **all** campaigns in the database, including GM secrets, so do not post it in a game channel. Copy backups off the machine yourself. Nothing is uploaded anywhere.

**Test a restore** into a separate directory without touching live data. This works while the bot is running:

```sh
npm run restore -- <backupId> --target-dir ./restore-test
```

It verifies the database and source checksums, `integrity_check` and table counts. You can point `npm run doctor` at the result with `DATA_DIR=./restore-test`. Use `--force` to overwrite an existing `rpg.sqlite` in the target directory.

**Live restore** requires the bot to be stopped. The script refuses while a running process holds the instance lock.

```sh
# stop the bot first
npm run restore -- <backupId>
# then start the bot again
```

Before overwriting anything, the current database (including `-wal`/`-shm`) and `sources/` are moved to `DATA_DIR/pre-restore-<timestamp>/`. `--force` skips that safety copy. `<backupId>` can also be a path to a backup directory. Newer migrations are applied when the bot next opens the database.

## 9. Tests and evaluations

```sh
npm test            # deterministic vitest suite: no network, no Discord, no model, no cost
npm run typecheck
```

```sh
npm run eval                 # full run: 3-player Lanternfall session (30+ turns) + Ashen Oaths pack switch
npm run eval -- --quick      # shorter 2-player Lanternfall session
EVAL_BUDGET_USD=1 npm run eval -- --quick
```

The runner drives the real turn runner, tools, records and provider in a temporary data directory. A capturing port stands in for Discord, so it does not exercise Discord itself. It covers AI character creation, NPC dialogue and memory, a rules question, a false claim, instruction injection, attempts to get hidden information, purchase, transfer, consumption, crafting, travel, construction, an owner world-advance, combat with spells, a mid-session restart, rest, quest progress, recap and cached recap, a correction, undo, and a backup restored into a clean instance. Its automated checks are storage-level only (did HP change, did an item move, did membership stay unchanged, did any GM-note text appear verbatim in a public reply).

`npm run eval` calls the configured model for real and **costs money** on a paid provider. Its total spend is capped by `EVAL_BUDGET_USD`. Reports are written to `evals/reports/`, which is git-ignored. Passing scenarios do not prove the rulings are correct. A person needs to read the transcripts and judge rule fidelity, narrative consistency and secret handling. Treat the model's own judgement as one input at most.

## Test status

Last updated 2026-10-22 on Windows 11, Node 24.20.0. Only the runs listed here actually happened.

**Deterministic suite (`npm test`): 163/163 passed in 11 files.** `npm run typecheck` and `npm run build` are clean. The suite covers every item in spec §14's deterministic list: replay idempotency; full rollback on failed validation; serialized concurrent turns; no identity, role, budget or source changes from the model; campaign isolation; dice reuse after retry and restart; cycles, dangling references, bad numbers and constraints; read-only ask and sheet; delivery retry without rerunning the action; undo and correction audit trails with no overwrite; budget stops, including configure/summary work; secret filtering in views, context and backups; backup restored into a clean instance; and PDF/text extraction gaps with no code execution.

**Startup:** `npm run doctor` passed (3 warnings: no Discord token or app ID on this machine). `node dist/src/index.js` reached Discord login and stopped cleanly on an invalid token, releasing its lock.

**Live model, GPT-6 Luna (reasoning `low`), `npm run eval` full run:** 32/34 checks passed. 3 players over 42 turns plus a 4-turn Ashen Oaths pack switch, 118 model calls, **$0.10**. No turn failed or needed owner attention. The two failed checks are model-ruling disagreements, not storage or security bugs:
- *Construction:* the GM narrated a barricade across the door but stored it only in the scene's text, not as its own record. This is a persistence miss to watch.
- *Spell:* the GM refused, correctly, because the character knew no attack spell and it was not her turn in the stored initiative. The automated check expected a cast.
Earlier quick runs, which I used to fix prompts, cost about $0.15 in total. They exposed a one-tool-call-per-response pattern and an input-token overestimate, both fixed.

**Live model, Ollama `qwen3.5:4b`, `npm run eval -- --quick`:** 19/29 checks passed, $0. The adapter worked end to end (tool calls, character creation, crafting, transfer, recap, undo, backup). The 4B model ran out of the 8-call limit on 9 turns. Those turns changed nothing and were reported to the player. A small local model is not a substitute for Luna at these limits.

**Not done:** the bot has **not** been run in a live Discord server or with real players. No Discord token was available. Discord behavior is covered only by unit tests with a faked REST client. Transcripts in `evals/reports/` have not had a full human review of rule fidelity.

## Limitations

- **The model is the GM, and it makes mistakes.** It can misapply rules, forget to save a consequence, narrate something that does not match the saved records, or rule inconsistently. The receipts under each play reply are built from what was actually saved, so check them against the narration. Use `/rpg gm` or `/rpg undo` to fix things.
- **Secrets can leak through narration.** GM notes and GM-only records are kept out of sheets, recaps and `/rpg ask` context in code. The GM model can still read them during play and may reveal them in prose. Filtering reduces this risk but cannot rule it out.
- **Constraints catch malformed bookkeeping, not unfair outcomes.** Optional constraints (required, integer, min/max, enum, immutable, field comparisons) reject bad data. They cannot tell whether loot or a reward was deserved. If the model can legitimately create an item, it can also create one by mistake.
- **Retrieval can miss things.** `search_reference` is full-text search over imported sections. A relevant clause may not be found, and the model then makes a provisional ruling.
- **Imports:** no OCR. Scanned or image-only PDF pages are reported and skipped. Tables and stat blocks in PDFs often extract badly, so review the import preview and correct the digest through `/rpg configure`. Only Markdown, plain text and text-layer PDFs are accepted.
- **One process, one machine.** No clustering or replicas. If the host sleeps or goes offline, the bot is offline.
- **Discord delivery is at-least-once, not exactly-once.** World changes are idempotent per request. Retried channel posts use a message nonce with `enforce_nonce` so Discord can drop duplicates, but a duplicate or missing message is still possible in rare network failures.
- **Private replies can be lost.** Ephemeral replies (`ask`, `character`, owner previews) can only be sent through the interaction token, which Discord expires after 15 minutes. If a private reply is not ready in time (a long queue, or a restart), it is dropped and recorded in `delivery_json`. Public replies fall back to a normal channel message.
- **Live Discord use:** unless [Test status](#test-status) says otherwise, this bot has not been run in a live Discord server with real players.
