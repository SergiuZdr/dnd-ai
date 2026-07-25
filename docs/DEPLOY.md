# DEPLOY — cloud, no tunnel (SRD Phase P2)

Goal: the game runs **always-on, on a public URL, with your laptop off**, and every player's turn spends **0 Claude tokens** (P1's `dmBackend:"openai"` path, talking to an OpenAI-compatible endpoint like OpenRouter; or P1.5's `dmBackend:"dual"` path — see below). Nothing below requires committing a `settings.json` or an API key — the server is configured **entirely via environment variables and secrets**.

Read this alongside `docs/SRD-cloud-open-model-hud.md` (why) and `docs/PRD-P1-pluggable-dm-backend.md` (the OpenAI-compatible DM backend this deploy runs).

## What's new here vs. local dev

`npm run serve` on your laptop still works exactly as before with **zero env vars set** — every var below has a safe local fallback. The cloud just sets more of them:

| Env var | Read by | Local default (no env set) | What it does |
|---|---|---|---|
| `PORT` | `src/web/serve.ts` | `3123` (or `--port`) | HTTP port to listen on |
| `HOST` | `src/web/serve.ts` | `0.0.0.0` (or `--host`) | Interface to bind |
| `GAME_PIN` | `src/web/serve.ts` | none — a fresh random PIN is generated **every boot** and printed to the console | Fixed PIN, so a cloud restart doesn't silently rotate the PIN nobody's watching the console for |
| `SAVES_DIR` | `src/web/serve.ts` | none — `createGameServer` falls back to `<cwd>/saves` | Where campaign saves live; point this at a mounted volume so saves survive a redeploy/restart |
| `DND_DM_BACKEND` | `src/game/settings.ts` | none — falls back to `settings.json`'s `dmBackend` (default `"claude"`) | `"claude"`, `"openai"`, or `"dual"` — which `DmSession` implementation runs the DM |
| `DND_OPENAI_BASE_URL` | `src/game/settings.ts` | none — falls back to `settings.json`'s `openai.baseUrl` | OpenAI-compatible endpoint, e.g. `https://openrouter.ai/api/v1` (shared by both models when `dmBackend:"dual"`) |
| `DND_OPENAI_MODEL` | `src/game/settings.ts` | none — falls back to `settings.json`'s `openai.model` | Model tag as the endpoint expects it -- the only model for `"openai"`; the **referee** (mechanics) model for `"dual"` |
| `DND_OPENAI_NARRATOR_MODEL` | `src/game/settings.ts` | none — falls back to `settings.json`'s `openai.narratorModel` | Only consulted when `dmBackend:"dual"`: the **narrator** (prose) model. Unset -> falls back to `DND_OPENAI_MODEL`/`openai.model` (with a friendly in-game note) |
| `DND_OPENAI_API_KEY_ENV` | `src/game/settings.ts` | none — falls back to `settings.json`'s `openai.apiKeyEnv`, or `OPENROUTER_API_KEY` once `DND_DM_BACKEND=openai`/`dual` is set via env with no apiKeyEnv known anywhere | **Name** of the env var the actual key lives in (never the key value itself) |

Precedence everywhere above is **env > `settings.json` > built-in default** — see `src/game/settings.ts`'s `applyEnvOverrides()`.

### `dmBackend:"dual"` — referee + narrator split (P1.5)

`"openai"` runs the whole DM (mechanics + prose) on one model. `"dual"` (`src/ai/dualDm.ts`) instead splits the turn across two models on the **same endpoint** (`DND_OPENAI_BASE_URL`/`apiKeyEnv`, just two model ids):

- **Referee** (`DND_OPENAI_MODEL` / `openai.model`) — the mechanics brain: runs the agentic tool loop (rolls, damage, gold, items, XP, quests, NPCs, location), then reports a terse internal beat sheet. Pick a model that reliably calls tools with well-formed arguments — this is the same bar as the single-model `"openai"` path (see the P1 PRD's spike finding: a 3B model is too weak). Recommended: `meta-llama/llama-3.3-70b-instruct`.
- **Narrator** (`DND_OPENAI_NARRATOR_MODEL` / `openai.narratorModel`) — the voice: takes the referee's beat sheet and writes the actual prose the player reads, with no tools of its own. Because it never touches game state, it's safe to point this at a more permissive/uncensored-leaning model for mature (`R`-rated) campaigns without risking the mechanics. Recommended: `nousresearch/hermes-3-llama-3.1-70b`.

Prove both halves before deploying:

```
DND_DM_BACKEND=dual \
DND_OPENAI_BASE_URL=https://openrouter.ai/api/v1 \
DND_OPENAI_MODEL=meta-llama/llama-3.3-70b-instruct \
DND_OPENAI_NARRATOR_MODEL=nousresearch/hermes-3-llama-3.1-70b \
OPENROUTER_API_KEY=sk-... \
npm run smoke:dual
```

Look for `REFEREE TOOL-CALLING SCORE: >=3/4` and `NARRATOR CHECK: PASS`.

**Secrets** (never in `fly.toml`, `Dockerfile`, or any committed file):

| Secret | Set via | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` (or whatever `DND_OPENAI_API_KEY_ENV` names) | `fly secrets set` / host env | The actual API key for your chosen OpenAI-compatible endpoint |
| `GAME_PIN` | `fly secrets set` / host env | The fixed PIN gating the public URL — treat it like a password, not a room number |

---

## Before you deploy anywhere: pick and prove a model

Free/small open models mangle tool-call arguments (see the P1 PRD's spike finding) — a 3B model is too weak. Pick a capable model on your chosen endpoint (OpenRouter is the default assumed here) and prove it clears the mechanics bar first:

```
DND_OPENAI_BASE_URL=https://openrouter.ai/api/v1 \
DND_OPENAI_MODEL=meta-llama/llama-3.1-70b-instruct \
OPENROUTER_API_KEY=sk-... \
npm run smoke:openai
```

Look for `TOOL-CALLING SCORE: >=3/4`. Swap `DND_OPENAI_MODEL` and re-run until one clears it — that's the model you put in `fly.toml` / your host's env.

---

## Option A: Fly.io (fastest path)

Fly's free allowance doesn't stretch to an **always-on** machine (this deploy disables auto-stop on purpose — see `fly.toml`'s comment — because a phone reconnecting the game's SSE stream after a cold start is a bad "laptop off" experience). Expect a small recurring cost for `shared-cpu-1x` / 512MB always-on. If you want genuinely $0/forever, skip to Option B.

1. **Install flyctl** (macOS): `brew install flyctl`, then `fly auth login`.

2. **Launch without deploying yet** (from the repo root — `Dockerfile` and `fly.toml` are already checked in):
   ```
   fly launch --no-deploy
   ```
   Follow the prompts (app name, region). If it asks to overwrite `fly.toml`, either decline or re-apply the `[mounts]`/`[http_service]`/`[env]` block from the committed one afterward — those aren't defaults `fly launch` knows to preserve.

3. **Create the persistent saves volume** (must match `fly.toml`'s `[[mounts]]` destination, `/data`):
   ```
   fly volumes create data --size 1
   ```
   (1 GB is generous for JSON saves; resize later with `fly volumes extend` if you ever need to.)

4. **Set secrets** (never in a file):
   ```
   fly secrets set OPENROUTER_API_KEY=sk-... GAME_PIN=482913871
   ```
   Use a **longer PIN than the local-dev 6 digits** for a public deploy — see Security notes below. Digits only isn't required by the server (it's compared as a plain string), but keep it something you can type on a phone.

5. **Review `fly.toml`'s `[env]` block** — `DND_OPENAI_MODEL` is a placeholder; set it to the model you proved with `npm run smoke:openai` above.

6. **Deploy:**
   ```
   fly deploy
   ```

7. **Open it:**
   ```
   fly open
   ```
   Or find the URL with `fly status`. Enter the PIN you set in step 4.

**Redeploys** (`fly deploy` again after a code change) reuse the same volume — saves persist. **Rolling back to Claude** is just `fly secrets unset` isn't even needed; set `DND_DM_BACKEND=claude` in `fly.toml`'s `[env]` (note: the Claude path needs a Claude Code login, which doesn't exist inside a headless container today — this rollback is really "redeploy locally," not a cloud option; see the PRD's rollback note).

---

## Option B: Oracle Cloud Always-Free VM (truly free, forever)

Oracle's Always Free tier includes an ARM (Ampere A1) VM that's genuinely free with no time limit — no GPU needed, the Node server is light. More setup than Fly, but $0 recurring, permanently.

1. **Create the VM**: Oracle Cloud Console → Compute → Instances → Create Instance. Pick an **Always Free** shape (Ampere A1, e.g. 1 OCPU / 6 GB is plenty), Ubuntu (22.04+ recommended), and save the SSH key pair it gives you.

2. **SSH in:**
   ```
   ssh -i <your-key.pem> ubuntu@<vm-public-ip>
   ```

3. **Install Node 20+:**
   ```
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs git
   ```

4. **Clone the repo and install:**
   ```
   git clone <this-repo-url> "dnd-ai"
   cd "dnd-ai"
   npm ci
   ```

5. **Set the same env vars** — put them in a file the process manager loads (do **not** commit this file; it's covered by `.gitignore`'s `.env*` pattern):
   ```
   cat > .env <<'EOF'
   PORT=3123
   HOST=0.0.0.0
   GAME_PIN=482913871
   SAVES_DIR=/home/ubuntu/dnd-ai-saves
   DND_DM_BACKEND=openai
   DND_OPENAI_BASE_URL=https://openrouter.ai/api/v1
   DND_OPENAI_MODEL=meta-llama/llama-3.1-70b-instruct
   OPENROUTER_API_KEY=sk-...
   EOF
   mkdir -p /home/ubuntu/dnd-ai-saves
   ```

6. **Run under a process manager** so it survives reboots/crashes. `pm2` is the simplest option and can load a `.env` file directly:
   ```
   sudo npm install -g pm2
   pm2 start "npm run serve" --name dnd-ai --env-file .env
   pm2 save
   pm2 startup   # follow the printed command to enable on-boot start
   ```
   (Older `pm2` versions lack `--env-file`; if so, `export $(grep -v '^#' .env | xargs) && pm2 start "npm run serve" --name dnd-ai` works, or switch to a `systemd` unit with `EnvironmentFile=/home/ubuntu/dnd-ai/.env`.)

7. **Open the firewall/port.** Two layers to open, both required:
   - **Oracle's Security List / Network Security Group** (Console → your VCN → Security Lists): add an ingress rule for the port you're actually exposing to the internet (443 if you put a reverse proxy in front — recommended, see next step — or 3123 if not).
   - **The VM's own firewall** (Ubuntu ships with `iptables` rules Oracle images pre-configure; if using `ufw`): `sudo ufw allow 443/tcp` (or `3123/tcp`).

8. **Put HTTPS in front** (strongly recommended — the game's PIN header/cookie-free auth and any future session state deserve TLS, and phones are pickier about mixed content). [Caddy](https://caddyserver.com/) gets you free automatic HTTPS with almost no config:
   ```
   sudo apt-get install -y caddy
   sudo tee /etc/caddy/Caddyfile > /dev/null <<'EOF'
   your-domain-or-ddns-name.example:443 {
     reverse_proxy 127.0.0.1:3123
   }
   EOF
   sudo systemctl restart caddy
   ```
   No domain yet? A free dynamic-DNS name (e.g. from DuckDNS) pointed at the VM's public IP works fine with Caddy's automatic cert issuance. Without a domain at all, you can skip HTTPS and use `http://<vm-ip>:3123` directly, but see the security note below.

9. **Test:** open `https://your-domain/` (or `http://<vm-ip>:3123`) from your phone, enter the PIN.

**Updating later:** `git pull && npm ci && pm2 restart dnd-ai`.

---

## Security notes (read before sharing the URL)

- **The PIN is the only gate.** This deploy has no accounts, no OAuth — once the URL is public, `GAME_PIN` is the entire barrier between "just my friends" and "anyone who finds the link." Treat it like a password:
  - Use **more than 6 digits** for a public deploy (the local-dev default is 6 digits, fine on a LAN; a public host should use a longer, less guessable value — `fly secrets set GAME_PIN=...` / the `.env` above both accept any string, not just digits).
  - **Never index or share the URL publicly** (no README badges, no public chat links) — treat the combination of "URL known" + "PIN known" as the actual access control.
- **The IP rate-limiter is already built in** (`src/web/server.ts`'s `PinRateLimiter` — 5 consecutive wrong-PIN attempts from one IP locks that IP out for 60s) and applies automatically to any deploy; it's not something you need to configure.
- **Never commit `.env`, `settings.json` with a real key, or any secret value** — `.gitignore` already excludes `.env`/`.env.*` and `settings.json`; the whole point of this deploy is that the server needs neither file at all (env vars + `fly secrets` / host env cover everything).
- **HTTPS**: Fly's `fly.toml` sets `force_https = true` and Fly provisions TLS automatically. On the Oracle path, put Caddy/nginx + a real cert (Caddy above does this automatically) in front rather than serving plain HTTP to a phone over the public internet.
- **Endpoint privacy/ToS**: whichever OpenAI-compatible endpoint you point `DND_OPENAI_BASE_URL` at may log or train on submitted data (uncensored/free-tier providers vary widely) — that's a provider choice, not something this app controls; self-hosting the model is the only way to get full control if that matters to you.
