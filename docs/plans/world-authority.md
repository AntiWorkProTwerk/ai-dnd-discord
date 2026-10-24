# Who decides what exists: outline ahead, fill in on demand

Status: built (2026-10-24). Notes from building it are at the end.

## Context

Players' words often assume things exist: "I go to the river by the inn", "I go to the nearest fur trader". The GM made those real on the spot, so the world took shape from player guesses: a hamlet could grow a market, facts drifted, and renders could change for no reason.

In D&D the GM owns the world. Players explore it and say what their characters try. Good GMs also say yes to small, plausible player details.

The owner's rule: **players interact with the world the GM creates; a player detail is accepted if it is not too breaking and doesn't change the world in big ways.**

The other open question was whether to prepare places ahead of time or make them up during play. This plan does both, the way human GMs prepare.

## Design

### Three layers

| Layer | Holds | When |
|---|---|---|
| **Outline** | Per town, village or district: `data.notable` (what is there and public, including what it lacks, e.g. "no smith"), plus secrets and who runs things in `gm_notes` | When the area is first created; filled in by background prep if missing |
| **Maps** | Grid maps of specific places (a street, a room) | When someone goes there, or prepared in the background just before |
| **Details** | Exact NPCs, prices, small objects | When a player asks or acts |

### Player details (GM rules, `src/prompts/gm.md` "What exists")

- **Settled** (in the records or the outline): answer from it. If the records rule something out, it isn't there; say what is.
- **Unsettled and small:** yes, often with a twist. The GM picks the specifics and saves them, so they stay true.
- **Unsettled and big:** no, or the player has to earn it (a check, time, a lead elsewhere).

### Unknown until seen

- **Fixed:** what players have seen. The server records every place a player character has been in during a committed play turn (the `seen_places` table, backfilled from stored map snapshots).
- **Server check:** a save that removes, moves or relabels a feature on a seen map, or shrinks the map, is rejected unless `save_turn.world_change` says what in the world changed it (a fire, a fight, builders). Background prep may never do this.
- **Always allowed:**
  - adding features (things brought in, hidden things revealed);
  - linking an exit that had no destination;
  - growing the map;
  - claiming an **open** feature.
- **Open features:** maps leave room for later additions, using features marked `"open": true` such as a shuttered shopfront, an unnamed house or a side alley. An open feature can be relabeled freely ("the shuttered shopfront is Brannoc's fur stall"). It must not be moved or removed without a reason.

### Area outline in the GM context

The GM sees the outline (and GM notes) of the town or region around the current place. If an area has no outline yet, it is told to add one.

### Look around (no model call)

`/rpg look [as]`, plus a 👀 button on each play message, shows privately and instantly:
- **Where you are:** the place and its area.
- **Ways out**, with direction and distance. A destination is named only if the party has been there, otherwise "unexplored".
- **Notable features**, with distance.
- **People you can see.** Hidden or concealed creatures are never shown.
- **The area's public outline.**
- **Places the party has seen nearby.**

### Background prep (mode `prep`)

After each committed play turn, the server looks for at most three tasks around the actor's place:
1. The containing area has no outline: outline it.
2. An exit leads to a location without a map: map it.
3. An exit has no destination: create the place beyond it and link both sides.

It then queues one background GM run on its own queue, so players are never blocked:
- **Rules for the run:**
  - one at a time per campaign;
  - deduped by task set;
  - switchable with `WORLD_PREP`.
- **Context:** the tasks, the maps, the outline and recent events.
- **What it can do:** create places, NPCs and items, and edit locations.
- **What it can't do:** touch characters or scenes, roll dice, or change anything players have seen.
- **Commit rules:** checked per record, like play, so play and prep can run side by side.
- **Visibility:** nothing is posted. The results show up when the party arrives.

## Files

- **New:**
  - `migrations/004_seen_places.sql`
  - `src/look.ts`
  - `tests/world-authority.test.ts`
- **Changed:**
  - `src/prompts/gm.md`
  - `src/agent.ts`: the area outline, the prep context and the prep instructions
  - `src/tools.ts`: the seen check, `world_change`, the prep commit rules, marking places seen
  - `src/maps.ts`: the `open` feature flag; the GM text map marks open features
  - `src/turns.ts`: `maybePrep`, the prep mode result, the 👀 button
  - `src/discord.ts`: `/rpg look` and the button
  - `src/types.ts`
  - `src/config.ts` and `.env.example`: `WORLD_PREP`
  - `README.md`

## Verification

- **Unit tests:**
  - changing a seen map is rejected without `world_change` and allowed with it;
  - additions, links and claiming open features are allowed;
  - unseen places can be changed freely;
  - look around hides secret things;
  - prep task selection;
  - prep scope rules;
  - the outline appears in the context.
- **Typecheck and the full test suite.**
- **Real-model check on a copy of the campaign:**
  - "is there a fur trader?" in Wickmere;
  - a big claim ("my uncle is the guard captain");
  - a prep run after moving.

## Notes from building it

- **Areas include mapped towns.** Wickmere had been given a single map by an older version. So "area" means any location that contains the current place, mapped or not.
- **Prep covers more than open edges.** It also prepares named doors and stairs that lead nowhere: the "guarded gate" at the Reeve's Hall was exactly where the player went next. Unnamed doors are skipped, since they are usually cupboards.
- **Outline changes are hidden from the receipts,** like maps and exits.
- **New prompt rule:** narration and records must agree. The GM once narrated walking to the market without moving the character. The server cannot check narration, so this is a prompt rule only.

### Real-model results (GPT-6 Luna, on a copy of the campaign)

| Action | Result |
|---|---|
| "Is there a fur trader anywhere around here?" | A small yes with a twist: a fur stall exists but is closed for the night. It was added to the new Wickmere outline, and Look around showed it. 10 s. |
| "The Reeve is my uncle… hand me the toll chain key" | Refused: the guards had never heard of it, and the key stays secured. 30 s, including making the gate place. |
| Waiting at the gate | Background prep built "Reeve's Hall Inner Court" (map, link back, guard routine in the GM notes) in about 12 s. Nothing was posted. |
