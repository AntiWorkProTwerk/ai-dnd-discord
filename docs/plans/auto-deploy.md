# Auto-deploy the live bot when main changes

Status: planned, not built. Not needed yet.

## Context

Friends contribute to the repository, but the real bot can only run on the owner's PC:
- **One Discord token.** Two copies of the bot online at once would both answer every command and button: duplicate replies and "interaction failed".
- **The world lives in the local SQLite database** under `data/`.
- **3D and image features need the local GPU setup:** Blender, ComfyUI and the `D:/Godot/...` pipelines.

So friends develop against their own test bot, and the owner's PC runs the real one. The PC picks up merged changes by polling GitHub. GitHub never has to reach the PC, and only code merged into `main` ever runs.

## Design

### 1. Separate live copy

Clone the repository into its own folder, e.g. `C:\Users\mryba\dmbot-live`. It holds its own `.env` and the real `data/` (point `DATA_DIR` there). The development folder can then have uncommitted work without blocking or breaking deploys.

### 2. pm2 keeps the bot running

- Start it with `pm2 start dist/src/index.js --name dmbot`, or `pm2 start npm --name dmbot -- start`.
- It restarts after crashes and starts on boot (pm2-windows-startup, or a logon task running `pm2 resurrect`).
- This replaces `npm run dev` in a terminal.

### 3. `scripts/deploy.ps1`

```
lock file (skip if another deploy is running)
git fetch origin main; exit if HEAD == origin/main
wait until no turn is running (or at most ~60 s)
npm run backup
git pull --ff-only
npm ci            # only when package-lock.json changed
npm run build
npm test
  any failure → git reset --hard <previous commit>, rebuild, keep the old process, log, exit
npm run register  # only when src/discord.ts (command definitions) changed
pm2 restart dmbot
optional: post "Bot updated: <commit titles>" in the campaign channel
append everything to data/logs/deploy.log
```

Database changes go through the existing migrations at startup, after the backup.

### 4. Windows Task Scheduler

```
schtasks /create /sc minute /mo 1 /tn DMBotDeploy /tr "pwsh -File C:\Users\mryba\dmbot-live\scripts\deploy.ps1"
```

### 5. GitHub side

- A workflow running `npm ci && npm run typecheck && npm test` on every pull request, on GitHub-hosted runners only. Never use a self-hosted runner on pull requests.
- Branch protection on `main`: pull request plus passing checks.
- A README section for contributors:
  - creating a test application and server;
  - their own `.env`;
  - running without the GPU features.

## Timing

**Push to live:**
- Typically 1–2 minutes with 1-minute polling and `npm ci` skipped when dependencies are unchanged.
- About 2–4 minutes with 3-minute polling.

| Step | Time |
|---|---|
| Waiting for the next poll | 0–1 min |
| Backup | ~seconds |
| `npm ci` (only when dependencies change) | 30–90 s |
| Build | 10–20 s |
| Tests | ~12 s |
| Restart | 5–10 s |

**Downtime** is only the 5–10 s restart: the old process answers while the new version builds and tests.

**Near-instant alternatives:**
- a self-hosted GitHub runner, never on PRs and preferably on a private repository;
- a webhook through a tunnel.

Both need more setup and expose the PC more, which isn't worth it for a hobby bot.

## Open questions

- Is the repository public or private? This only matters for the runner alternative.
- Should the "Bot updated" notice be posted in Discord?
- How should a restart mid-turn be handled? Check how an interrupted running turn is recovered; otherwise the script waits for idle.
