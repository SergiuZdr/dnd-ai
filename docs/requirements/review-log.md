# Requirements review log

## 2026-07-23 — SRD: cloud + open-model DM + BG3 HUD

**Doc:** `docs/requirements/SRD-cloud-open-model-hud.md` (V0.1)

### Retrospective
- **Thinnest sections:** §3.2 business value and §8.2 A/B (both minimal by nature — private, single-user project). Deliberately left thin, not a gap.
- **The real unknown (by design, not omission):** *which* free + uncensored + tool-calling model actually clears a "playable mechanics" bar. This can only be settled by an empirical spike, not more questioning — captured as Open Item #1 and risk #1.
- **Questions that would've helped earlier:** (1) the cost ceiling — "free vs. small budget" only surfaced as a late note on an unselected option; asking it up front would have framed the whole model discussion. (2) What "Ollama" meant (local runner vs Ollama Cloud) — resolved via the hosting question and by abstracting to "any OpenAI-compatible endpoint."
- **Key reframe made during gathering:** "use Ollama" → "code to an OpenAI-compatible endpoint" so model/host/cost become configuration, not a rewrite. This dissolves most of the free-vs-reliable tension into a swappable setting.
