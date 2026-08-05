# Graph Report - .  (2026-08-05)

## Corpus Check
- 87 files · ~130,104 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1369 nodes · 2682 edges · 78 communities (66 shown, 12 thin omitted)
- Extraction: 93% EXTRACTED · 7% INFERRED · 0% AMBIGUOUS · INFERRED: 190 edges (avg confidence: 0.88)
- Token cost: 840,561 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 73|Community 73]]
- [[_COMMUNITY_Community 74|Community 74]]
- [[_COMMUNITY_Community 75|Community 75]]
- [[_COMMUNITY_Community 76|Community 76]]
- [[_COMMUNITY_Community 77|Community 77]]

## God Nodes (most connected - your core abstractions)
1. `GameController` - 53 edges
2. `DualModelDmSession` - 50 edges
3. `GameState` - 41 edges
4. `createDmTools()` - 36 edges
5. `Engine` - 35 edges
6. `loadSettings()` - 34 edges
7. `OpenAiDmSession` - 32 edges
8. `createGameServer()` - 30 edges
9. `GameBridge` - 27 edges
10. `DmSession` - 27 edges

## Surprising Connections (you probably didn't know these)
- `Cloudflared-missing fallback to LAN-only with install hints` --semantically_similar_to--> `Deploy Option B: Oracle Cloud Always-Free ARM VM`  [INFERRED] [semantically similar]
  scripts/tunnel.ts → docs/DEPLOY.md
- `Step 0 spike: de-risk subscription auth + MCP + streaming` --semantically_similar_to--> `Pick and prove a model before deploying`  [INFERRED] [semantically similar]
  scripts/smoke/spike.ts → docs/DEPLOY.md
- `Chronicle guard: refuse to cut below lastSummarizedIndex` --semantically_similar_to--> `Durability: versioned envelope, atomic write, .deleted/ instead of unlink`  [INFERRED] [semantically similar]
  scripts/admin/rewind.ts → docs/design/PLAN.md
- `Explicit reviewed RENAMES list instead of a regex` --semantically_similar_to--> `PR-7: argument validate-and-repair layer`  [INFERRED] [semantically similar]
  scripts/admin/fix-item-names.ts → docs/requirements/PRD-P1-pluggable-dm-backend.md
- `InputBar()` --semantically_similar_to--> `renderInputState (Act/Stop/thinking row)`  [INFERRED] [semantically similar]
  src/ui/InputBar.tsx → src/web/index.html

## Hyperedges (group relationships)
- **The dual referee+narrator backend, specified, documented and proven** — readme_dual_backend, docs_deploy_dual_referee_narrator, design_plan_three_dm_backends, smoke_dual_smoke_referee_score, smoke_dual_smoke_narrator_check, requirements_srd_cloud_open_model_hud_content_ceiling [INFERRED 0.85]
- **Zero-Claude-token play: problem, requirement, config and deploy** — requirements_srd_cloud_open_model_hud_token_drain, requirements_prd_p1_pluggable_dm_backend_pr5_summarizer, docs_deploy_zero_claude_tokens, docs_deploy_env_var_precedence, readme_choosing_the_dm [INFERRED 0.85]
- **Per-player access codes and save isolation across CLI, server and docs** — readme_access_codes, admin_players_access_code_cli, admin_migrate_to_players_collision_refusal, design_plan_multiplayer_isolation, docs_deploy_two_auth_modes [INFERRED 0.85]
- **Referee-then-narrator turn pipeline** — ai_prompts_refereesystemprompt, ai_prompts_narratorsystemprompt, ai_dualdm_runrefereephase, ai_dualdm_runnarratorphase, ai_dualdm_buildnarratoruserprompt, ai_dualdm_tooloutcomerecord, ai_dualdm_formatherogroundtruth [EXTRACTED 1.00]
- **Interactive player dice roll (tool call parked until the player clicks)** — ai_tools_rolldice, ai_tools_toolhooks, game_controller_handleinteractiveroll, game_controller_confirmroll, game_controller_resolvependingroll, game_engine_rerollwithluck, game_controller_appendrollentry [EXTRACTED 1.00]
- **Chronicle rotation: summarize the tail, swap sessions, hold the brief** — game_controller_shouldsummarize, game_controller_runchronicleupdate, ai_summarizer_summarizechunk, ai_prompts_buildcontextbrief, game_saves_readtranscript, game_controller_forever_memory [EXTRACTED 1.00]
- **Pending-roll flow: prompt, tap/SPACE, reveal, luck decision** — ui_diceline_diceline, ui_inputbar_roll_pending_input_ownership, web_bridge_attach, web_server_handlerollconfirm, web_index_renderrollsheet, web_index_showrevealed [INFERRED 0.85]
- **Slash commands: shared formatters, two dispatchers, two system-entry sinks** — ui_slashcommands_shared_formatting_ui_free, ui_app_handleslashcommand, web_server_handleslashcommand, ui_app_appendsystementry, web_bridge_appendsystementry [EXTRACTED 1.00]
- **Character creation / retire: one preset catalog, two wizards, one save path** — wizard_wizard_wizard, web_index_wizard, web_server_handlepresets, web_server_handlenew, web_server_handleretire, web_index_basestatarray [INFERRED 0.85]
- **Keeping a weak referee/narrator pair mechanically honest** — ai_prompts_test_mechanics_guardrails, ai_dualdm_test_zero_tool_nudge, ai_dualdm_test_missing_defeat_foe_nudge, ai_dualdm_test_narrator_ground_truth, ai_tools_test_defeat_foe_single_call [INFERRED 0.85]
- **SUGGEST trailer: asked for, parsed, then stripped from every durable surface** — ai_prompts_test_suggest_trailer_contract, ai_suggestions_test_trailer_parsing_tolerance, ai_suggestions_test_marker_never_flashes, game_controller_test_trailer_stripped_from_durable_surfaces [INFERRED 0.85]
- **dmBackend fans out to three independent routing decisions** — game_settings_test_dual_backend_validation, game_defaultsessionfactory_test_backend_selection, ai_summarizerbackend_test_dual_routes_to_openai [INFERRED 0.95]
- **Pure-core testing: direct-run guards and injected factories keep the suite from booting real I/O or an Agent SDK session** — scripts_saverepair_test_direct_run_guard, web_serve_test_direct_run_guard, web_webserver_test_fake_controller_no_dmsession, web_webbridge_test_sanitized_state_data_only [EXTRACTED 1.00]
- **Per-player isolation boundary: the save path is the authorisation, across listing, sessions, SSE, deletion and shutdown** — web_webserverplayers_test_save_isolation, web_webserverplayers_test_session_isolation, web_webserverplayers_test_sse_isolation, web_webserverplayers_test_path_traversal_containment, web_webserverplayers_test_shutdown_drains_all, web_webserverplayers_test_sse_ticket_single_use [EXTRACTED 1.00]
- **A roll's numbers are always visible where the roll happened, on both the terminal and web paths** — ui_layout_test_dice_card_three_rows, ui_diceline_test_reveal_row_excludes_reason, ui_diceline_test_compact_summary_kept_total, web_webbridge_test_dice_roll_inert_rolls_as_story_entries [INFERRED 0.85]

## Communities (78 total, 12 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.06
Nodes (62): arg(), Refuse the whole migration on any destination collision, legacyCampaignSlugs(), main(), Owner CLI for the player registry (add/list/rotate/revoke), campaignCount(), First registered player flips the server to access-code mode, main() (+54 more)

### Community 1 - "Community 1"
Cohesion: 0.05
Nodes (38): Context brief forbids restating/recapping what the player already read, cleanSuggestion(), SplitSuggestions, SUGGEST_MARKER trailer sentinel, cases, long, Every prefix of the marker is withheld from the live stream, partial (+30 more)

### Community 2 - "Community 2"
Cohesion: 0.05
Nodes (36): SSE over WebSockets for a turn-based phone client, Two front ends, one core (ControllerCallbacks seam), npm run play (legacy TUI), TUI CLI entry point, settings.json self-heals before the UI mounts, All game state reaches React only through ControllerCallbacks, The dice card is a fixed 3-row card (2 rows truncated the numbers off), At scrollOffset 0 the newest content is always the last line (+28 more)

### Community 3 - "Community 3"
Cohesion: 0.06
Nodes (42): backup(), Count-baked-into-item-name bug breaks removeItem, Item, main(), parseArgs(), Rename, RENAMES, repairInventory() (+34 more)

### Community 4 - "Community 4"
Cohesion: 0.05
Nodes (43): Oracle VM deploy access (ssh/rsync to /opt/dnd), Claude Code local permission allowlist, Explicit reviewed RENAMES list instead of a regex, Dry run by default, tar backup before --apply, Repair-then-validate malformed tool arguments, Hybrid engine: code owns dice/HP/XP/gold/inventory, Three DM backends behind one DmSessionLike surface, The trust boundary is the tool layer (11 tools) (+35 more)

### Community 5 - "Community 5"
Cohesion: 0.10
Nodes (39): npm run serve, npm run serve:remote, Remote access: Tailscale vs Cloudflare quick tunnel, CliArgs, Cloudflared-missing fallback to LAN-only with install hints, generatePin(), isCloudflaredInstalled(), lanUrls() (+31 more)

### Community 6 - "Community 6"
Cohesion: 0.07
Nodes (38): StoryEntry, LineText(), StoryLog(), StoryLogProps, BLANK_LINE, computeStoryViewport(), SCROLL_INDICATOR, StoryLine (+30 more)

### Community 7 - "Community 7"
Cohesion: 0.09
Nodes (19): classifyThrownError(), DmErrorKind, DmSession, DmSessionCallbacks, DmSessionConfig, errorMessageOf(), stripDndPrefix(), ControllerCallbacks (+11 more)

### Community 8 - "Community 8"
Cohesion: 0.06
Nodes (28): appended, baseDir, brief, calls, cb, { cb, baseDir }, { cb, session, baseDir }, { cb, session, baseDir, state } (+20 more)

### Community 9 - "Community 9"
Cohesion: 0.11
Nodes (28): assignStats(), ClassPreset, RACES, Stats, InputBarProps, Only the focused option shows its description, SelectList(), SelectListProps (+20 more)

### Community 10 - "Community 10"
Cohesion: 0.08
Nodes (25): CallToolResultLike, ChatMessage, extractText(), OpenAiDmSessionOptions, ToolMessageCall, AccumulatedToolCall, OpenAiStreamChunk, OpenAiToolCallDelta (+17 more)

### Community 11 - "Community 11"
Cohesion: 0.07
Nodes (26): alice, bob, bySlug, campaignFile, characterFile, corrupt, dir, entries (+18 more)

### Community 12 - "Community 12"
Cohesion: 0.10
Nodes (25): abilityMod(), backgroundClause(), buildContextBrief(), buildNewHeroPrompt(), buildOpeningPrompt(), ContextBriefOptions, heroSheetLine(), signed() (+17 more)

### Community 13 - "Community 13"
Cohesion: 0.13
Nodes (26): withMechanicsReminder(), createDmTools(), InteractiveRollRequest, onLedger fires exactly once per successful gain/loss, never on failure, roll_dice schema demands a 3-6 word reason, never a sentence, toCallToolResult(), ToolHooks, GameController.handleInteractiveRoll (+18 more)

### Community 14 - "Community 14"
Cohesion: 0.07
Nodes (28): dependencies, @anthropic-ai/claude-agent-sdk, ink, ink-text-input, react, zod, devDependencies, tsx (+20 more)

### Community 15 - "Community 15"
Cohesion: 0.11
Nodes (25): RollRevealResult, compactSummary(), Fixed 3-row dice card phase machine (idle/waiting/animating/revealed), DiceLine(), DiceLineProps, DIE_FACES, Fallback-message echo suppression by content, needLine() (+17 more)

### Community 16 - "Community 16"
Cohesion: 0.14
Nodes (6): DualModelDmSession, extractText(), Narrator request carries no tools/tool_choice and uses narratorModel, Referee content never reaches onDelta; only narrator prose does, A stream that opens and goes silent is broken by a stall timeout, Referee is nudged exactly once when a turn resolved no tools

### Community 17 - "Community 17"
Cohesion: 0.09
Nodes (19): beatSheetOnly(), deadBeatSheet(), deltaCalls, emptyStream(), { engine, session, callbacks }, fetchMock, interactiveRoll, makeSession() (+11 more)

### Community 18 - "Community 18"
Cohesion: 0.09
Nodes (18): addItem, awardGold, awardXp, defeatFoe, engine, engineSpy, interactiveRoll, npc (+10 more)

### Community 19 - "Community 19"
Cohesion: 0.09
Nodes (20): allStats, baseStats, before, byId, byName, conMod, copy, dexMod (+12 more)

### Community 20 - "Community 20"
Cohesion: 0.15
Nodes (20): applyRaceBonuses(), BackgroundPreset, BACKGROUNDS, buildCharacter(), canonicalRaceName(), createNewCampaign(), createNewHero(), findRace() (+12 more)

### Community 21 - "Community 21"
Cohesion: 0.15
Nodes (18): Empty narration retried within a budget, then given up honestly, classifyNetworkError(), delay(), errorMessageOf(), fetchWithRetry(), FetchWithRetryOptions, isAbortError(), isTransientRateLimit() (+10 more)

### Community 22 - "Community 22"
Cohesion: 0.15
Nodes (20): Narrator falls back to openai.model with a friendly system note, dmBackend:'dual' summarizes over HTTP, never the Claude SDK, defaultSessionFactory(), defaultSessionFactory maps dmBackend to the right session class, applyEnvOverrides(), DEFAULT_OPENAI_SETTINGS, DEFAULT_SETTINGS, DmBackend (+12 more)

### Community 23 - "Community 23"
Cohesion: 0.14
Nodes (19): appendTurnText(), Assistant text segments get a blank-line separator, never bare glue, result, beatSheetReportsFoeDown, DualModelDmSession.consumeStream, DualModelDmSession.executeToolCall, landedAnAttack(), postNarratorCompletion (+11 more)

### Community 24 - "Community 24"
Cohesion: 0.16
Nodes (16): defeat_foe pays XP and records the foe in one call, ParsedDice, RollMode, RollResult, Engine.awardXp, RollEngineResult, XP crosses multiple thresholds at once; luck +1 per level, capped at 3, abilityMod() (+8 more)

### Community 25 - "Community 25"
Cohesion: 0.19
Nodes (18): Chronicle, appendSystemEntry (TUI), enterGame, handleSlashCommand (TUI dispatch), Negative counting-down ids for locally synthesized entries, quit, formatCharacterSheet(), formatHelp() (+10 more)

### Community 26 - "Community 26"
Cohesion: 0.14
Nodes (8): Referee-phase and narrator-phase HTTP failures both surface as DmError, roller:'player' pauses the dual turn before the narrator phase, interrupt() aborts in flight without onError/onTurnComplete, OpenAiDmSession, A 401 classifies as an auth DmError and clears busy, roller:'player' parks the agentic loop until the hook resolves, interrupt() aborts without retrying and without callbacks, A tool call runs the same handler the Claude backend uses

### Community 27 - "Community 27"
Cohesion: 0.16
Nodes (14): buildNarratorUserPrompt(), CallToolResultLike, DualModelDmSessionOptions, extractBriefHint(), formatToolOutcomes(), NarratorMessage, RefereeMessage, stripMechanicsReminder() (+6 more)

### Community 28 - "Community 28"
Cohesion: 0.16
Nodes (18): describeCondition(), formatHeroGroundTruth(), Once-per-turn referee nudges (zero-tool, missing combat consequence), Referee + narrator two-model split, describeCondition states CONSCIOUS/DOWN outright, never inferable, Missing defeat_foe / apply_damage nudge keys off mechanics, not prose, Narrator prompt carries the hero's real post-turn numbers, dmSystemPrompt() (+10 more)

### Community 29 - "Community 29"
Cohesion: 0.12
Nodes (11): DmError, assistantMsg, { engine, session, callbacks }, fetchMock, interactiveRoll, makeSession(), makeState(), secondBody (+3 more)

### Community 30 - "Community 30"
Cohesion: 0.12
Nodes (14): GameControllerOptions, CLASS_PRESETS, roll4d6DropLowest(), STANDARD_ARRAY, THEMES, SseSink, __dirname, INDEX_HTML_PATH (+6 more)

### Community 31 - "Community 31"
Cohesion: 0.14
Nodes (18): createGameServer(), Lockout is per-IP, not per-guess: after N failures even the correct PIN 429s, and success resets the counter, /api/end shuts the controller down and clears the session, and is a harmless no-op when idle, Errors return JSON with no stack-trace leakage, and the server survives a malformed request, The HTTP suite injects a fake controller so no real DmSession/Agent SDK is ever spawned, Invalid campaign creation input 400s and constructs no controller at all, Every data route is PIN-gated while GET / stays open, so the login screen can always load, Retire swaps in a new hero on the SAME campaign slug and leaves an "A new hero rises" transcript note (+10 more)

### Community 32 - "Community 32"
Cohesion: 0.17
Nodes (14): roll_dice tool, interactiveRoll is used only for roller:'player', GameController.buildReveal, GameController.confirmRoll, roll(), sum(), Advantage/disadvantage record both attempts and tie-break to the first, dcSuffix() (+6 more)

### Community 33 - "Community 33"
Cohesion: 0.12
Nodes (14): beat, calls, completed, conMod, created, dup, first, firstSpy (+6 more)

### Community 34 - "Community 34"
Cohesion: 0.17
Nodes (13): buildSummarizerPrompt(), callOpenAiChatOnce(), parseSummarizerReply(), summarizeChunk(), SummarizeInput, SummarizeOutput, chunk, prompt (+5 more)

### Community 35 - "Community 35"
Cohesion: 0.19
Nodes (13): CampaignListing, envelopeSchema, latestCampaign(), listCampaigns(), migrateCharacter(), migrateWorld(), readHeroSummary(), readJson() (+5 more)

### Community 36 - "Community 36"
Cohesion: 0.27
Nodes (3): Engine, isBoundedInt(), onMutation fires exactly once per successful mutation, never for rollDice

### Community 37 - "Community 37"
Cohesion: 0.13
Nodes (10): cb, controller, entries, playerStoryEntries, playerTranscriptEntries, saved, sessions, shutdownPromise (+2 more)

### Community 38 - "Community 38"
Cohesion: 0.19
Nodes (13): App(), AppProps, enterWizard, GameStartMode, handleSubmit, Mode, readDimensions(), InputBar() (+5 more)

### Community 39 - "Community 39"
Cohesion: 0.13
Nodes (9): GameServerOptions, body, controller, decoder, fighter, note, reader, TestServer (+1 more)

### Community 40 - "Community 40"
Cohesion: 0.15
Nodes (9): GameServerHandle, ac, alice, bob, bobStream, retired, stream, text (+1 more)

### Community 41 - "Community 41"
Cohesion: 0.20
Nodes (11): A player id can never escape the players directory, deleteCampaign(), Per-player isolation via the baseDir seam, saveGame(), SavePaths, deleteCampaign retires into .deleted rather than destroying, Saves are {schemaVersion,data} envelopes with an atomic write, A campaign slug that resolves outside its save dir is refused (+3 more)

### Community 42 - "Community 42"
Cohesion: 0.17
Nodes (9): addItem, awardGold, awardXp, engine, heal, result, rollDice, { tools } (+1 more)

### Community 43 - "Community 43"
Cohesion: 0.17
Nodes (8): body, CHUNK, headers, loadSettingsMock, messages, queryMock, LoadedSettings, Settings

### Community 44 - "Community 44"
Cohesion: 0.24
Nodes (9): computeStoryHeight(), DICE_AREA_HEIGHT, Whole-frame-height invariant, INPUT_BAR_HEIGHT, storyHeight + DICE_AREA_HEIGHT + INPUT_BAR_HEIGHT is exactly `rows`, at every supported size, Story height never drops below 1, even for a pathologically small terminal, storyHeight, Five-screen state machine (title/pin/campaigns/wizard/play) (+1 more)

### Community 45 - "Community 45"
Cohesion: 0.22
Nodes (9): ArgRepairResult, repairAndValidateArgs(), Numeric string coerced to number, non-numeric string is not, Hallucinated extra keys are dropped, call stays valid, Unrepairable args return ok:false, never throw, Repair unwraps JSON-Schema-shaped {type,value} args, unwrapJsonSchemaValue(), Content deltas stream through and the turn completes without tools (+1 more)

### Community 46 - "Community 46"
Cohesion: 0.20
Nodes (9): compilerOptions, jsx, module, moduleResolution, noEmit, skipLibCheck, strict, target (+1 more)

### Community 47 - "Community 47"
Cohesion: 0.20
Nodes (8): parseDice(), advantage, disadvantage, invalidCases, Dice expression parsing enforces count/sides/modifier bounds, result, rng, validCases

### Community 48 - "Community 48"
Cohesion: 0.20
Nodes (8): actualRequired, engine, EXPECTED_TOOL_NAMES, expectedRequired, rollDice, schema, schemas, { tools }

### Community 49 - "Community 49"
Cohesion: 0.20
Nodes (9): resolveModelOption(), DEFAULT_OPENAI, Missing settings.json is created with haiku/claude defaults, no warning, filePath, firstWrite, { settings }, { settings, warning }, withoutEnv (+1 more)

### Community 50 - "Community 50"
Cohesion: 0.31
Nodes (9): nextXpThreshold(), hpBarColor(), renderHpBar(), Sidebar(), SidebarProps, SanitizedState, sanitizeState(), renderDrawer (character sheet panel) (+1 more)

### Community 51 - "Community 51"
Cohesion: 0.22
Nodes (10): Scroll anchoring: snap only on player entry or fresh stream, Transient vs mirrored SSE events, appendFeedEntry, appendInlineMarkup (safe inline markdown), autoScroll / isNearBottom, flushLedgerToast (loot/XP toast), openEventStream (SSE event handlers), renderFeed / story feed (+2 more)

### Community 52 - "Community 52"
Cohesion: 0.20
Nodes (10): Idempotent hello snapshot for phone reconnects, apiFetch (credential header + 401 bounce), applyAuthMode (shapes the single login field), boot, connectSse (ticket exchange), enterAfterAuth (landing rule), scheduleSseReconnect (client-owned backoff), signOut (+2 more)

### Community 53 - "Community 53"
Cohesion: 0.25
Nodes (9): GameBridge.detach, handleDeleteCampaign (POST /api/campaign/delete), handleEnd (POST /api/end), handleInterrupt (POST /api/interrupt), handleRollConfirm (POST /api/roll/confirm), handleRollResolve (POST /api/roll/resolve), Per-player session isolation via saveDir + own SSE sinks, requestListener (route table) (+1 more)

### Community 54 - "Community 54"
Cohesion: 0.31
Nodes (9): Terminal drops 'roll' story entries, GameBridge.attach, onDiceRoll deliberately does nothing on web, baseStatArray (what gets POSTed), submitWizard, handleNew (POST /api/new), handleRetire (POST /api/retire), parseStatValues() (+1 more)

### Community 58 - "Community 58"
Cohesion: 0.33
Nodes (7): Prompt names award_gold/spend_gold and bans modify_gold, award_gold tool, Direction lives in the tool choice, not a signed argument, spend_gold tool, Gold direction comes from the tool, not the sign of the amount, Engine.modifyGold, Gold can never go negative and the error states the current balance

### Community 59 - "Community 59"
Cohesion: 0.33
Nodes (5): { config, callbacks }, loadSettingsMock, makeConfigAndCallbacks(), makeState(), session

### Community 60 - "Community 60"
Cohesion: 0.33
Nodes (7): authMode defaults to the permissive 'code', so every failure path fails open, An access code survives keystroke-by-keystroke sanitising in code mode, The exact corruption is pinned as a test so nobody reinstates the unconditional digit filter, PIN mode still strips non-digits and caps at 6 characters, A matching If-None-Match answers 304 with an empty body, keeping revalidation cheap, index.html is served no-cache + ETag so a phone cannot pin itself to a stale login screen, /api/auth-mode answers without a credential and leaks nothing but the mode

### Community 62 - "Community 62"
Cohesion: 0.33
Nodes (6): GameBridge.broadcastHello, GameBridge.hello, HelloSnapshot, GameBridge.subscribe, Plain http + SSE instead of WebSockets, handleEvents (GET /api/events, SSE)

### Community 63 - "Community 63"
Cohesion: 0.40
Nodes (5): Interactive player rolls park the tool handler promise, Tool schemas derived from the same zod shapes (no drift), Interactive hero dice roll + luck reroll, PR-2: hand-rolled agentic tool loop, PR-6: zod -> OpenAI function schema conversion

### Community 64 - "Community 64"
Cohesion: 0.40
Nodes (5): defeat_foe tool, resolveFoeName(), defeat_foe matches a loosely-named foe already on the roster, Notes/facts collections cap and drop the oldest, Engine.upsertNpc

### Community 65 - "Community 65"
Cohesion: 0.40
Nodes (5): index.html deliberately one file, no bundler, No build step: tsx runs the sources directly, P3: BG3-style HUD replaces the chatbox layout, Stdlib-only launcher (no new dependency), Strict TypeScript config (noEmit, ESNext, react-jsx)

### Community 67 - "Community 67"
Cohesion: 0.60
Nodes (4): makeCallbacks(), makeState(), startNew(), startResume()

### Community 70 - "Community 70"
Cohesion: 0.50
Nodes (4): GameController.resolvePendingRoll, confirmRoll/resolvePendingRoll orchestrate the luck reroll, Engine.rerollWithLuck, rerollWithLuck spends the luck even when the reroll is worse

### Community 71 - "Community 71"
Cohesion: 0.50
Nodes (3): debug, --render-check paints once and exits, unbilled, runRenderCheck()

### Community 72 - "Community 72"
Cohesion: 0.50
Nodes (4): confirmDeleteCampaign (inline confirm), continueCampaign, renderCampaignList (campaign shelf), handleContinue (POST /api/continue)

## Ambiguous Edges - Review These
- `DmSession` → `Stream stall watchdog (silence, not duration)`  [AMBIGUOUS]
  src/ai/dm.ts · relation: conceptually_related_to

## Knowledge Gaps
- **470 isolated node(s):** `name`, `private`, `type`, `node`, `serve` (+465 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **12 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `DmSession` and `Stream stall watchdog (silence, not duration)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `GameState` connect `Community 7` to `Community 2`, `Community 8`, `Community 9`, `Community 11`, `Community 12`, `Community 13`, `Community 17`, `Community 18`, `Community 19`, `Community 20`, `Community 23`, `Community 24`, `Community 25`, `Community 27`, `Community 28`, `Community 29`, `Community 30`, `Community 33`, `Community 35`, `Community 36`, `Community 37`, `Community 38`, `Community 39`, `Community 40`, `Community 41`, `Community 42`, `Community 48`, `Community 50`, `Community 59`, `Community 64`?**
  _High betweenness centrality (0.117) - this node is a cross-community bridge._
- **Why does `GameController` connect `Community 1` to `Community 2`, `Community 3`, `Community 36`, `Community 37`, `Community 38`, `Community 7`, `Community 8`, `Community 41`, `Community 34`, `Community 12`, `Community 13`, `Community 22`, `Community 30`?**
  _High betweenness centrality (0.094) - this node is a cross-community bridge._
- **Why does `DualModelDmSession` connect `Community 16` to `Community 4`, `Community 7`, `Community 59`, `Community 10`, `Community 13`, `Community 17`, `Community 21`, `Community 22`, `Community 26`, `Community 27`, `Community 28`?**
  _High betweenness centrality (0.059) - this node is a cross-community bridge._
- **Are the 7 inferred relationships involving `GameController` (e.g. with `main()` and `saveGame()`) actually correct?**
  _`GameController` has 7 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `createDmTools()` (e.g. with `repairAndValidateArgs()` and `The engine owns the numbers (prose never invents mechanics)`) actually correct?**
  _`createDmTools()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `private`, `type` to the rest of the system?**
  _519 weakly-connected nodes found - possible documentation gaps or missing edges._