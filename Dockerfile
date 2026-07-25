# Dockerfile -- always-on cloud deploy (SRD Phase P2: "Cloud, no tunnel").
# Runs the exact same entry point local dev uses (`npm run serve` ->
# src/web/serve.ts) -- no build step, no bundler, same tsx runtime -- and is
# configured ENTIRELY via env vars/secrets so nothing here (or in the image)
# needs a committed settings.json or API key. See docs/DEPLOY.md for the
# full deploy walkthrough (Fly.io and an Oracle Always-Free VM alternative).
#
# Env vars this image respects at runtime (all read by src/web/serve.ts /
# src/game/settings.ts, all with safe local-dev fallbacks):
#   PORT              -- default 3123
#   HOST              -- default 0.0.0.0
#   SAVES_DIR         -- default /data/saves (see the volume note below)
#   GAME_PIN          -- SECRET. Fixed PIN; unset -> a fresh random one is
#                        generated every restart (fine on a laptop, useless
#                        in the cloud where nobody's watching the console).
#   DND_DM_BACKEND    -- 'claude' | 'openai'
#   DND_OPENAI_BASE_URL, DND_OPENAI_MODEL, DND_OPENAI_API_KEY_ENV
#   OPENROUTER_API_KEY (or whatever DND_OPENAI_API_KEY_ENV names) -- SECRET.
FROM node:20-slim

WORKDIR /app

# Install deps first so `npm ci` layer-caches across rebuilds that only
# change game code. tsx/typescript are devDependencies but ARE needed at
# runtime here -- this project has no build step by design (see README:
# `tsx` runs the TypeScript directly) -- so this is a full `npm ci`, not
# `--omit=dev`.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Default persistent-saves location. A real deploy mounts a volume here
# (fly.toml's [mounts], or `docker run -v mysaves:/data/saves`); without a
# mount this still works, it's just as ephemeral as the container itself.
RUN mkdir -p /data/saves
ENV SAVES_DIR=/data/saves
ENV HOST=0.0.0.0
ENV PORT=3123
# GAME_PIN and the OpenAI-compatible API key are secrets -- deliberately NOT
# set here. Supply them at deploy time (`fly secrets set`, `docker run -e`,
# or your host's secrets manager). See docs/DEPLOY.md.

EXPOSE 3123

# Exec form + the tsx binary directly (NOT `npm run serve`) so this process
# is PID 1 and receives SIGTERM directly from `docker stop` / the platform's
# rolling restarts. serve.ts's shutdown handler needs that signal promptly
# to autosave before the container dies -- routing through `npm run serve`
# would interpose an npm process that doesn't always forward signals in time.
CMD ["node_modules/.bin/tsx", "src/web/serve.ts"]
