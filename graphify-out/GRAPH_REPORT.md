# Graph Report - .  (2026-08-05)

## Corpus Check
- 87 files · ~130,104 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1369 nodes · 2682 edges · 78 communities (66 shown, 12 thin omitted)
- Extraction: 93% EXTRACTED · 7% INFERRED · 0% AMBIGUOUS · INFERRED: 190 edges (avg confidence: 0.88)
- Token cost: 840,561 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Player Registry & Access Codes|Player Registry & Access Codes]]
- [[_COMMUNITY_Suggestion Trailer & Session Rotation|Suggestion Trailer & Session Rotation]]
- [[_COMMUNITY_Two Front Ends, One Core|Two Front Ends, One Core]]
- [[_COMMUNITY_Save Repair & Forever Memory|Save Repair & Forever Memory]]
- [[_COMMUNITY_Architecture Decisions & Deploy|Architecture Decisions & Deploy]]
- [[_COMMUNITY_Serve Launcher & Tunnel|Serve Launcher & Tunnel]]
- [[_COMMUNITY_Story Log Viewport|Story Log Viewport]]
- [[_COMMUNITY_Claude DM Session|Claude DM Session]]
- [[_COMMUNITY_Controller Test Fixtures|Controller Test Fixtures]]
- [[_COMMUNITY_Character Creation Wizard UI|Character Creation Wizard UI]]
- [[_COMMUNITY_OpenAI Stream Decoding|OpenAI Stream Decoding]]
- [[_COMMUNITY_Save Listing Test Fixtures|Save Listing Test Fixtures]]
- [[_COMMUNITY_Context Brief Prompts|Context Brief Prompts]]
- [[_COMMUNITY_DM Tool Layer & Hooks|DM Tool Layer & Hooks]]
- [[_COMMUNITY_Package Dependencies|Package Dependencies]]
- [[_COMMUNITY_Dice Card Rendering|Dice Card Rendering]]
- [[_COMMUNITY_Dual Model Session|Dual Model Session]]
- [[_COMMUNITY_Dual DM Test Harness|Dual DM Test Harness]]
- [[_COMMUNITY_Tool Handler Tests|Tool Handler Tests]]
- [[_COMMUNITY_Hero Stat Rolling Tests|Hero Stat Rolling Tests]]
- [[_COMMUNITY_New Campaign & Hero|New Campaign & Hero]]
- [[_COMMUNITY_HTTP Retry & Backoff|HTTP Retry & Backoff]]
- [[_COMMUNITY_Settings & Backend Selection|Settings & Backend Selection]]
- [[_COMMUNITY_Turn Loop Phases|Turn Loop Phases]]
- [[_COMMUNITY_Engine Types & XP Table|Engine Types & XP Table]]
- [[_COMMUNITY_Slash Commands|Slash Commands]]
- [[_COMMUNITY_OpenAI DM Session|OpenAI DM Session]]
- [[_COMMUNITY_Narrator Prompts & Tool Schemas|Narrator Prompts & Tool Schemas]]
- [[_COMMUNITY_Referee & Narrator System Prompts|Referee & Narrator System Prompts]]
- [[_COMMUNITY_DM Error Handling|DM Error Handling]]
- [[_COMMUNITY_Web Presets & Static Serving|Web Presets & Static Serving]]
- [[_COMMUNITY_Web Server Security Suite|Web Server Security Suite]]
- [[_COMMUNITY_Dice Rolling & Reveal|Dice Rolling & Reveal]]
- [[_COMMUNITY_Engine Mutation Tests|Engine Mutation Tests]]
- [[_COMMUNITY_Chronicle Summarizer|Chronicle Summarizer]]
- [[_COMMUNITY_Save Schema & Migration|Save Schema & Migration]]
- [[_COMMUNITY_Engine Mutations|Engine Mutations]]
- [[_COMMUNITY_Chronicle Rotation Tests|Chronicle Rotation Tests]]
- [[_COMMUNITY_TUI App Shell & Menu|TUI App Shell & Menu]]
- [[_COMMUNITY_Web Server Test Fixtures|Web Server Test Fixtures]]
- [[_COMMUNITY_Multiplayer Isolation Tests|Multiplayer Isolation Tests]]
- [[_COMMUNITY_Save Path Containment|Save Path Containment]]
- [[_COMMUNITY_Arg Repair Tests|Arg Repair Tests]]
- [[_COMMUNITY_Summarizer Backend Tests|Summarizer Backend Tests]]
- [[_COMMUNITY_Layout Height Invariant|Layout Height Invariant]]
- [[_COMMUNITY_Tool Argument Repair|Tool Argument Repair]]
- [[_COMMUNITY_TypeScript Config|TypeScript Config]]
- [[_COMMUNITY_Dice Expression Parsing|Dice Expression Parsing]]
- [[_COMMUNITY_Tool Schema Parity Tests|Tool Schema Parity Tests]]
- [[_COMMUNITY_Settings Defaults Tests|Settings Defaults Tests]]
- [[_COMMUNITY_Sidebar HUD & Vitals|Sidebar HUD & Vitals]]
- [[_COMMUNITY_Web Feed Rendering|Web Feed Rendering]]
- [[_COMMUNITY_Web Auth & SSE Client|Web Auth & SSE Client]]
- [[_COMMUNITY_Web Route Handlers|Web Route Handlers]]
- [[_COMMUNITY_Wizard Submit & Roll Entries|Wizard Submit & Roll Entries]]
- [[_COMMUNITY_Fake Controller (web tests)|Fake Controller (web tests)]]
- [[_COMMUNITY_Fake Controller (players tests)|Fake Controller (players tests)]]
- [[_COMMUNITY_Fake Session (game tests)|Fake Session (game tests)]]
- [[_COMMUNITY_Gold Direction Tools|Gold Direction Tools]]
- [[_COMMUNITY_Session Factory Tests|Session Factory Tests]]
- [[_COMMUNITY_Login Field Sanitising|Login Field Sanitising]]
- [[_COMMUNITY_Recording Session Fixture|Recording Session Fixture]]
- [[_COMMUNITY_SSE Hello Snapshot|SSE Hello Snapshot]]
- [[_COMMUNITY_Interactive Roll & Schema Derivation|Interactive Roll & Schema Derivation]]
- [[_COMMUNITY_Foe Defeat & NPC Roster|Foe Defeat & NPC Roster]]
- [[_COMMUNITY_No-Build-Step Toolchain|No-Build-Step Toolchain]]
- [[_COMMUNITY_Callback Capturing Fixture|Callback Capturing Fixture]]
- [[_COMMUNITY_Campaign Start Fixtures|Campaign Start Fixtures]]
- [[_COMMUNITY_PIN Rate Limiter|PIN Rate Limiter]]
- [[_COMMUNITY_SSE Ticket Store|SSE Ticket Store]]
- [[_COMMUNITY_Luck Reroll Flow|Luck Reroll Flow]]
- [[_COMMUNITY_CLI Entry & Render Check|CLI Entry & Render Check]]
- [[_COMMUNITY_Web Campaign Shelf|Web Campaign Shelf]]
- [[_COMMUNITY_Claude Code Permissions|Claude Code Permissions]]
- [[_COMMUNITY_Login Field Test Harness|Login Field Test Harness]]
- [[_COMMUNITY_Claude Headless Limitation|Claude Headless Limitation]]
- [[_COMMUNITY_Quest Reward Round-Trip|Quest Reward Round-Trip]]
- [[_COMMUNITY_Quest Reward Update Guard|Quest Reward Update Guard]]

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

### Community 0 - "Player Registry & Access Codes"
Cohesion: 0.06
Nodes (62): arg(), Refuse the whole migration on any destination collision, legacyCampaignSlugs(), main(), Owner CLI for the player registry (add/list/rotate/revoke), campaignCount(), First registered player flips the server to access-code mode, main() (+54 more)

### Community 1 - "Suggestion Trailer & Session Rotation"
Cohesion: 0.05
Nodes (38): Context brief forbids restating/recapping what the player already read, cleanSuggestion(), SplitSuggestions, SUGGEST_MARKER trailer sentinel, cases, long, Every prefix of the marker is withheld from the live stream, partial (+30 more)

### Community 2 - "Two Front Ends, One Core"
Cohesion: 0.05
Nodes (36): SSE over WebSockets for a turn-based phone client, Two front ends, one core (ControllerCallbacks seam), npm run play (legacy TUI), TUI CLI entry point, settings.json self-heals before the UI mounts, All game state reaches React only through ControllerCallbacks, The dice card is a fixed 3-row card (2 rows truncated the numbers off), At scrollOffset 0 the newest content is always the last line (+28 more)

### Community 3 - "Save Repair & Forever Memory"
Cohesion: 0.06
Nodes (42): backup(), Count-baked-into-item-name bug breaks removeItem, Item, main(), parseArgs(), Rename, RENAMES, repairInventory() (+34 more)

### Community 4 - "Architecture Decisions & Deploy"
Cohesion: 0.05
Nodes (43): Oracle VM deploy access (ssh/rsync to /opt/dnd), Claude Code local permission allowlist, Explicit reviewed RENAMES list instead of a regex, Dry run by default, tar backup before --apply, Repair-then-validate malformed tool arguments, Hybrid engine: code owns dice/HP/XP/gold/inventory, Three DM backends behind one DmSessionLike surface, The trust boundary is the tool layer (11 tools) (+35 more)

### Community 5 - "Serve Launcher & Tunnel"
Cohesion: 0.10
Nodes (39): npm run serve, npm run serve:remote, Remote access: Tailscale vs Cloudflare quick tunnel, CliArgs, Cloudflared-missing fallback to LAN-only with install hints, generatePin(), isCloudflaredInstalled(), lanUrls() (+31 more)

### Community 6 - "Story Log Viewport"
Cohesion: 0.07
Nodes (38): StoryEntry, LineText(), StoryLog(), StoryLogProps, BLANK_LINE, computeStoryViewport(), SCROLL_INDICATOR, StoryLine (+30 more)

### Community 7 - "Claude DM Session"
Cohesion: 0.09
Nodes (19): classifyThrownError(), DmErrorKind, DmSession, DmSessionCallbacks, DmSessionConfig, errorMessageOf(), stripDndPrefix(), ControllerCallbacks (+11 more)

### Community 8 - "Controller Test Fixtures"
Cohesion: 0.06
Nodes (28): appended, baseDir, brief, calls, cb, { cb, baseDir }, { cb, session, baseDir }, { cb, session, baseDir, state } (+20 more)

### Community 9 - "Character Creation Wizard UI"
Cohesion: 0.11
Nodes (28): assignStats(), ClassPreset, RACES, Stats, InputBarProps, Only the focused option shows its description, SelectList(), SelectListProps (+20 more)

### Community 10 - "OpenAI Stream Decoding"
Cohesion: 0.08
Nodes (25): CallToolResultLike, ChatMessage, extractText(), OpenAiDmSessionOptions, ToolMessageCall, AccumulatedToolCall, OpenAiStreamChunk, OpenAiToolCallDelta (+17 more)

### Community 11 - "Save Listing Test Fixtures"
Cohesion: 0.07
Nodes (26): alice, bob, bySlug, campaignFile, characterFile, corrupt, dir, entries (+18 more)

### Community 12 - "Context Brief Prompts"
Cohesion: 0.10
Nodes (25): abilityMod(), backgroundClause(), buildContextBrief(), buildNewHeroPrompt(), buildOpeningPrompt(), ContextBriefOptions, heroSheetLine(), signed() (+17 more)

### Community 13 - "DM Tool Layer & Hooks"
Cohesion: 0.13
Nodes (26): withMechanicsReminder(), createDmTools(), InteractiveRollRequest, onLedger fires exactly once per successful gain/loss, never on failure, roll_dice schema demands a 3-6 word reason, never a sentence, toCallToolResult(), ToolHooks, GameController.handleInteractiveRoll (+18 more)

### Community 14 - "Package Dependencies"
Cohesion: 0.07
Nodes (28): dependencies, @anthropic-ai/claude-agent-sdk, ink, ink-text-input, react, zod, devDependencies, tsx (+20 more)

### Community 15 - "Dice Card Rendering"
Cohesion: 0.11
Nodes (25): RollRevealResult, compactSummary(), Fixed 3-row dice card phase machine (idle/waiting/animating/revealed), DiceLine(), DiceLineProps, DIE_FACES, Fallback-message echo suppression by content, needLine() (+17 more)

### Community 16 - "Dual Model Session"
Cohesion: 0.14
Nodes (6): DualModelDmSession, extractText(), Narrator request carries no tools/tool_choice and uses narratorModel, Referee content never reaches onDelta; only narrator prose does, A stream that opens and goes silent is broken by a stall timeout, Referee is nudged exactly once when a turn resolved no tools

### Community 17 - "Dual DM Test Harness"
Cohesion: 0.09
Nodes (19): beatSheetOnly(), deadBeatSheet(), deltaCalls, emptyStream(), { engine, session, callbacks }, fetchMock, interactiveRoll, makeSession() (+11 more)

### Community 18 - "Tool Handler Tests"
Cohesion: 0.09
Nodes (18): addItem, awardGold, awardXp, defeatFoe, engine, engineSpy, interactiveRoll, npc (+10 more)

### Community 19 - "Hero Stat Rolling Tests"
Cohesion: 0.09
Nodes (20): allStats, baseStats, before, byId, byName, conMod, copy, dexMod (+12 more)

### Community 20 - "New Campaign & Hero"
Cohesion: 0.15
Nodes (20): applyRaceBonuses(), BackgroundPreset, BACKGROUNDS, buildCharacter(), canonicalRaceName(), createNewCampaign(), createNewHero(), findRace() (+12 more)

### Community 21 - "HTTP Retry & Backoff"
Cohesion: 0.15
Nodes (18): Empty narration retried within a budget, then given up honestly, classifyNetworkError(), delay(), errorMessageOf(), fetchWithRetry(), FetchWithRetryOptions, isAbortError(), isTransientRateLimit() (+10 more)

### Community 22 - "Settings & Backend Selection"
Cohesion: 0.15
Nodes (20): Narrator falls back to openai.model with a friendly system note, dmBackend:'dual' summarizes over HTTP, never the Claude SDK, defaultSessionFactory(), defaultSessionFactory maps dmBackend to the right session class, applyEnvOverrides(), DEFAULT_OPENAI_SETTINGS, DEFAULT_SETTINGS, DmBackend (+12 more)

### Community 23 - "Turn Loop Phases"
Cohesion: 0.14
Nodes (19): appendTurnText(), Assistant text segments get a blank-line separator, never bare glue, result, beatSheetReportsFoeDown, DualModelDmSession.consumeStream, DualModelDmSession.executeToolCall, landedAnAttack(), postNarratorCompletion (+11 more)

### Community 24 - "Engine Types & XP Table"
Cohesion: 0.16
Nodes (16): defeat_foe pays XP and records the foe in one call, ParsedDice, RollMode, RollResult, Engine.awardXp, RollEngineResult, XP crosses multiple thresholds at once; luck +1 per level, capped at 3, abilityMod() (+8 more)

### Community 25 - "Slash Commands"
Cohesion: 0.19
Nodes (18): Chronicle, appendSystemEntry (TUI), enterGame, handleSlashCommand (TUI dispatch), Negative counting-down ids for locally synthesized entries, quit, formatCharacterSheet(), formatHelp() (+10 more)

### Community 26 - "OpenAI DM Session"
Cohesion: 0.14
Nodes (8): Referee-phase and narrator-phase HTTP failures both surface as DmError, roller:'player' pauses the dual turn before the narrator phase, interrupt() aborts in flight without onError/onTurnComplete, OpenAiDmSession, A 401 classifies as an auth DmError and clears busy, roller:'player' parks the agentic loop until the hook resolves, interrupt() aborts without retrying and without callbacks, A tool call runs the same handler the Claude backend uses

### Community 27 - "Narrator Prompts & Tool Schemas"
Cohesion: 0.16
Nodes (14): buildNarratorUserPrompt(), CallToolResultLike, DualModelDmSessionOptions, extractBriefHint(), formatToolOutcomes(), NarratorMessage, RefereeMessage, stripMechanicsReminder() (+6 more)

### Community 28 - "Referee & Narrator System Prompts"
Cohesion: 0.16
Nodes (18): describeCondition(), formatHeroGroundTruth(), Once-per-turn referee nudges (zero-tool, missing combat consequence), Referee + narrator two-model split, describeCondition states CONSCIOUS/DOWN outright, never inferable, Missing defeat_foe / apply_damage nudge keys off mechanics, not prose, Narrator prompt carries the hero's real post-turn numbers, dmSystemPrompt() (+10 more)

### Community 29 - "DM Error Handling"
Cohesion: 0.12
Nodes (11): DmError, assistantMsg, { engine, session, callbacks }, fetchMock, interactiveRoll, makeSession(), makeState(), secondBody (+3 more)

### Community 30 - "Web Presets & Static Serving"
Cohesion: 0.12
Nodes (14): GameControllerOptions, CLASS_PRESETS, roll4d6DropLowest(), STANDARD_ARRAY, THEMES, SseSink, __dirname, INDEX_HTML_PATH (+6 more)

### Community 31 - "Web Server Security Suite"
Cohesion: 0.14
Nodes (18): createGameServer(), Lockout is per-IP, not per-guess: after N failures even the correct PIN 429s, and success resets the counter, /api/end shuts the controller down and clears the session, and is a harmless no-op when idle, Errors return JSON with no stack-trace leakage, and the server survives a malformed request, The HTTP suite injects a fake controller so no real DmSession/Agent SDK is ever spawned, Invalid campaign creation input 400s and constructs no controller at all, Every data route is PIN-gated while GET / stays open, so the login screen can always load, Retire swaps in a new hero on the SAME campaign slug and leaves an "A new hero rises" transcript note (+10 more)

### Community 32 - "Dice Rolling & Reveal"
Cohesion: 0.17
Nodes (14): roll_dice tool, interactiveRoll is used only for roller:'player', GameController.buildReveal, GameController.confirmRoll, roll(), sum(), Advantage/disadvantage record both attempts and tie-break to the first, dcSuffix() (+6 more)

### Community 33 - "Engine Mutation Tests"
Cohesion: 0.12
Nodes (14): beat, calls, completed, conMod, created, dup, first, firstSpy (+6 more)

### Community 34 - "Chronicle Summarizer"
Cohesion: 0.17
Nodes (13): buildSummarizerPrompt(), callOpenAiChatOnce(), parseSummarizerReply(), summarizeChunk(), SummarizeInput, SummarizeOutput, chunk, prompt (+5 more)

### Community 35 - "Save Schema & Migration"
Cohesion: 0.19
Nodes (13): CampaignListing, envelopeSchema, latestCampaign(), listCampaigns(), migrateCharacter(), migrateWorld(), readHeroSummary(), readJson() (+5 more)

### Community 36 - "Engine Mutations"
Cohesion: 0.27
Nodes (3): Engine, isBoundedInt(), onMutation fires exactly once per successful mutation, never for rollDice

### Community 37 - "Chronicle Rotation Tests"
Cohesion: 0.13
Nodes (10): cb, controller, entries, playerStoryEntries, playerTranscriptEntries, saved, sessions, shutdownPromise (+2 more)

### Community 38 - "TUI App Shell & Menu"
Cohesion: 0.19
Nodes (13): App(), AppProps, enterWizard, GameStartMode, handleSubmit, Mode, readDimensions(), InputBar() (+5 more)

### Community 39 - "Web Server Test Fixtures"
Cohesion: 0.13
Nodes (9): GameServerOptions, body, controller, decoder, fighter, note, reader, TestServer (+1 more)

### Community 40 - "Multiplayer Isolation Tests"
Cohesion: 0.15
Nodes (9): GameServerHandle, ac, alice, bob, bobStream, retired, stream, text (+1 more)

### Community 41 - "Save Path Containment"
Cohesion: 0.20
Nodes (11): A player id can never escape the players directory, deleteCampaign(), Per-player isolation via the baseDir seam, saveGame(), SavePaths, deleteCampaign retires into .deleted rather than destroying, Saves are {schemaVersion,data} envelopes with an atomic write, A campaign slug that resolves outside its save dir is refused (+3 more)

### Community 42 - "Arg Repair Tests"
Cohesion: 0.17
Nodes (9): addItem, awardGold, awardXp, engine, heal, result, rollDice, { tools } (+1 more)

### Community 43 - "Summarizer Backend Tests"
Cohesion: 0.17
Nodes (8): body, CHUNK, headers, loadSettingsMock, messages, queryMock, LoadedSettings, Settings

### Community 44 - "Layout Height Invariant"
Cohesion: 0.24
Nodes (9): computeStoryHeight(), DICE_AREA_HEIGHT, Whole-frame-height invariant, INPUT_BAR_HEIGHT, storyHeight + DICE_AREA_HEIGHT + INPUT_BAR_HEIGHT is exactly `rows`, at every supported size, Story height never drops below 1, even for a pathologically small terminal, storyHeight, Five-screen state machine (title/pin/campaigns/wizard/play) (+1 more)

### Community 45 - "Tool Argument Repair"
Cohesion: 0.22
Nodes (9): ArgRepairResult, repairAndValidateArgs(), Numeric string coerced to number, non-numeric string is not, Hallucinated extra keys are dropped, call stays valid, Unrepairable args return ok:false, never throw, Repair unwraps JSON-Schema-shaped {type,value} args, unwrapJsonSchemaValue(), Content deltas stream through and the turn completes without tools (+1 more)

### Community 46 - "TypeScript Config"
Cohesion: 0.20
Nodes (9): compilerOptions, jsx, module, moduleResolution, noEmit, skipLibCheck, strict, target (+1 more)

### Community 47 - "Dice Expression Parsing"
Cohesion: 0.20
Nodes (8): parseDice(), advantage, disadvantage, invalidCases, Dice expression parsing enforces count/sides/modifier bounds, result, rng, validCases

### Community 48 - "Tool Schema Parity Tests"
Cohesion: 0.20
Nodes (8): actualRequired, engine, EXPECTED_TOOL_NAMES, expectedRequired, rollDice, schema, schemas, { tools }

### Community 49 - "Settings Defaults Tests"
Cohesion: 0.20
Nodes (9): resolveModelOption(), DEFAULT_OPENAI, Missing settings.json is created with haiku/claude defaults, no warning, filePath, firstWrite, { settings }, { settings, warning }, withoutEnv (+1 more)

### Community 50 - "Sidebar HUD & Vitals"
Cohesion: 0.31
Nodes (9): nextXpThreshold(), hpBarColor(), renderHpBar(), Sidebar(), SidebarProps, SanitizedState, sanitizeState(), renderDrawer (character sheet panel) (+1 more)

### Community 51 - "Web Feed Rendering"
Cohesion: 0.22
Nodes (10): Scroll anchoring: snap only on player entry or fresh stream, Transient vs mirrored SSE events, appendFeedEntry, appendInlineMarkup (safe inline markdown), autoScroll / isNearBottom, flushLedgerToast (loot/XP toast), openEventStream (SSE event handlers), renderFeed / story feed (+2 more)

### Community 52 - "Web Auth & SSE Client"
Cohesion: 0.20
Nodes (10): Idempotent hello snapshot for phone reconnects, apiFetch (credential header + 401 bounce), applyAuthMode (shapes the single login field), boot, connectSse (ticket exchange), enterAfterAuth (landing rule), scheduleSseReconnect (client-owned backoff), signOut (+2 more)

### Community 53 - "Web Route Handlers"
Cohesion: 0.25
Nodes (9): GameBridge.detach, handleDeleteCampaign (POST /api/campaign/delete), handleEnd (POST /api/end), handleInterrupt (POST /api/interrupt), handleRollConfirm (POST /api/roll/confirm), handleRollResolve (POST /api/roll/resolve), Per-player session isolation via saveDir + own SSE sinks, requestListener (route table) (+1 more)

### Community 54 - "Wizard Submit & Roll Entries"
Cohesion: 0.31
Nodes (9): Terminal drops 'roll' story entries, GameBridge.attach, onDiceRoll deliberately does nothing on web, baseStatArray (what gets POSTed), submitWizard, handleNew (POST /api/new), handleRetire (POST /api/retire), parseStatValues() (+1 more)

### Community 58 - "Gold Direction Tools"
Cohesion: 0.33
Nodes (7): Prompt names award_gold/spend_gold and bans modify_gold, award_gold tool, Direction lives in the tool choice, not a signed argument, spend_gold tool, Gold direction comes from the tool, not the sign of the amount, Engine.modifyGold, Gold can never go negative and the error states the current balance

### Community 59 - "Session Factory Tests"
Cohesion: 0.33
Nodes (5): { config, callbacks }, loadSettingsMock, makeConfigAndCallbacks(), makeState(), session

### Community 60 - "Login Field Sanitising"
Cohesion: 0.33
Nodes (7): authMode defaults to the permissive 'code', so every failure path fails open, An access code survives keystroke-by-keystroke sanitising in code mode, The exact corruption is pinned as a test so nobody reinstates the unconditional digit filter, PIN mode still strips non-digits and caps at 6 characters, A matching If-None-Match answers 304 with an empty body, keeping revalidation cheap, index.html is served no-cache + ETag so a phone cannot pin itself to a stale login screen, /api/auth-mode answers without a credential and leaks nothing but the mode

### Community 62 - "SSE Hello Snapshot"
Cohesion: 0.33
Nodes (6): GameBridge.broadcastHello, GameBridge.hello, HelloSnapshot, GameBridge.subscribe, Plain http + SSE instead of WebSockets, handleEvents (GET /api/events, SSE)

### Community 63 - "Interactive Roll & Schema Derivation"
Cohesion: 0.40
Nodes (5): Interactive player rolls park the tool handler promise, Tool schemas derived from the same zod shapes (no drift), Interactive hero dice roll + luck reroll, PR-2: hand-rolled agentic tool loop, PR-6: zod -> OpenAI function schema conversion

### Community 64 - "Foe Defeat & NPC Roster"
Cohesion: 0.40
Nodes (5): defeat_foe tool, resolveFoeName(), defeat_foe matches a loosely-named foe already on the roster, Notes/facts collections cap and drop the oldest, Engine.upsertNpc

### Community 65 - "No-Build-Step Toolchain"
Cohesion: 0.40
Nodes (5): index.html deliberately one file, no bundler, No build step: tsx runs the sources directly, P3: BG3-style HUD replaces the chatbox layout, Stdlib-only launcher (no new dependency), Strict TypeScript config (noEmit, ESNext, react-jsx)

### Community 67 - "Campaign Start Fixtures"
Cohesion: 0.60
Nodes (4): makeCallbacks(), makeState(), startNew(), startResume()

### Community 70 - "Luck Reroll Flow"
Cohesion: 0.50
Nodes (4): GameController.resolvePendingRoll, confirmRoll/resolvePendingRoll orchestrate the luck reroll, Engine.rerollWithLuck, rerollWithLuck spends the luck even when the reroll is worse

### Community 71 - "CLI Entry & Render Check"
Cohesion: 0.50
Nodes (3): debug, --render-check paints once and exits, unbilled, runRenderCheck()

### Community 72 - "Web Campaign Shelf"
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
- **Why does `GameState` connect `Claude DM Session` to `Two Front Ends, One Core`, `Controller Test Fixtures`, `Character Creation Wizard UI`, `Save Listing Test Fixtures`, `Context Brief Prompts`, `DM Tool Layer & Hooks`, `Dual DM Test Harness`, `Tool Handler Tests`, `Hero Stat Rolling Tests`, `New Campaign & Hero`, `Turn Loop Phases`, `Engine Types & XP Table`, `Slash Commands`, `Narrator Prompts & Tool Schemas`, `Referee & Narrator System Prompts`, `DM Error Handling`, `Web Presets & Static Serving`, `Engine Mutation Tests`, `Save Schema & Migration`, `Engine Mutations`, `Chronicle Rotation Tests`, `TUI App Shell & Menu`, `Web Server Test Fixtures`, `Multiplayer Isolation Tests`, `Save Path Containment`, `Arg Repair Tests`, `Tool Schema Parity Tests`, `Sidebar HUD & Vitals`, `Session Factory Tests`, `Foe Defeat & NPC Roster`?**
  _High betweenness centrality (0.117) - this node is a cross-community bridge._
- **Why does `GameController` connect `Suggestion Trailer & Session Rotation` to `Two Front Ends, One Core`, `Save Repair & Forever Memory`, `Engine Mutations`, `Chronicle Rotation Tests`, `TUI App Shell & Menu`, `Claude DM Session`, `Controller Test Fixtures`, `Save Path Containment`, `Chronicle Summarizer`, `Context Brief Prompts`, `DM Tool Layer & Hooks`, `Settings & Backend Selection`, `Web Presets & Static Serving`?**
  _High betweenness centrality (0.094) - this node is a cross-community bridge._
- **Why does `DualModelDmSession` connect `Dual Model Session` to `Architecture Decisions & Deploy`, `Claude DM Session`, `Session Factory Tests`, `OpenAI Stream Decoding`, `DM Tool Layer & Hooks`, `Dual DM Test Harness`, `HTTP Retry & Backoff`, `Settings & Backend Selection`, `OpenAI DM Session`, `Narrator Prompts & Tool Schemas`, `Referee & Narrator System Prompts`?**
  _High betweenness centrality (0.059) - this node is a cross-community bridge._
- **Are the 7 inferred relationships involving `GameController` (e.g. with `main()` and `saveGame()`) actually correct?**
  _`GameController` has 7 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `createDmTools()` (e.g. with `repairAndValidateArgs()` and `The engine owns the numbers (prose never invents mechanics)`) actually correct?**
  _`createDmTools()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `private`, `type` to the rest of the system?**
  _519 weakly-connected nodes found - possible documentation gaps or missing edges._