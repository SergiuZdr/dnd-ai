// Top-level shell: picks between the size warning, main menu, wizard, and
// live game screen, and owns the one GameController instance for a play
// session. All game-related React state is fed exclusively through
// ControllerCallbacks -- this component never reaches into the engine/DM
// session directly.
//
// Slash commands are parsed here (never inside the controller, which stays
// UI-free): InputBar just forwards whatever text was submitted, and
// handleSlashCommand below decides whether it's a local command or a plain
// player action to forward to the controller.
import { useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import type { GameState } from '../game/state';
import { GameController } from '../game/controller';
import type { PendingRollRequest, StoryEntry } from '../game/controller';
import { loadGame } from '../game/saves';
import { Menu } from './Menu';
import { StoryLog } from './StoryLog';
import { Sidebar } from './Sidebar';
import { DiceLine } from './DiceLine';
import { InputBar } from './InputBar';
import { Wizard } from './wizard/Wizard';
import { formatHelp, formatCharacterSheet, formatJournal, unknownCommandNote } from './slashCommands';
import { DICE_AREA_HEIGHT, computeStoryHeight } from './layout';

type Mode = 'menu' | 'wizard' | 'game';
type GameStartMode = 'new' | 'resume' | 'new-hero';

const MIN_COLUMNS = 80;
const MIN_ROWS = 20;
const SIDEBAR_WIDTH = 34;

function readDimensions(stdout: NodeJS.WriteStream): { columns: number; rows: number } {
  // `||` not `??`: some ptys (CI, `script`) report 0×0, which would otherwise
  // collapse the layout to a blank screen.
  return { columns: stdout.columns || MIN_COLUMNS, rows: stdout.rows || MIN_ROWS };
}

export interface AppProps {
  /** --debug flag from argv: logs every raw SDK message to saves/<slug>/debug.log. */
  debug?: boolean;
}

export function App({ debug = false }: AppProps = {}) {
  const { stdout } = useStdout();
  const [dimensions, setDimensions] = useState(() => readDimensions(stdout));

  useEffect(() => {
    const onResize = () => setDimensions(readDimensions(stdout));
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  const [mode, setMode] = useState<Mode>('menu');
  const controllerRef = useRef<GameController | null>(null);
  const stateRef = useRef<GameState | null>(null);
  const systemIdRef = useRef(0);
  // Non-null while the wizard is running for /retire (the fallen hero's state,
  // kept around so the wizard can build the new GameState from its
  // campaign/world/chronicle); null while running for a brand-new campaign.
  const [pendingRetire, setPendingRetire] = useState<GameState | null>(null);

  const [entries, setEntries] = useState<StoryEntry[]>([]);
  const [partial, setPartial] = useState('');
  const [busy, setBusy] = useState(false);
  const [diceMessage, setDiceMessage] = useState('');
  const [pendingRoll, setPendingRoll] = useState<PendingRollRequest | null>(null);
  // GameState is mutated in place by the Engine, so its object reference never
  // changes -- this counter is the only thing that forces Sidebar to re-render
  // with fresh values after onStateChange fires.
  const [, bumpStateVersion] = useReducer((c: number) => c + 1, 0);

  useEffect(
    () => () => {
      // Best-effort cleanup if the whole app unmounts outside the normal
      // /quit flow (e.g. Ctrl+C, or the render-check's timed unmount).
      void controllerRef.current?.shutdown();
    },
    [],
  );

  function appendSystemEntry(text: string): void {
    systemIdRef.current -= 1;
    setEntries((prev) => [...prev, { id: systemIdRef.current, kind: 'system', text }]);
  }

  function enterGame(state: GameState, gameMode: GameStartMode): void {
    stateRef.current = state;
    setEntries([]);
    setPartial('');
    setDiceMessage('');
    setPendingRoll(null);
    setBusy(false);
    systemIdRef.current = 0;

    const controller = new GameController(
      state,
      {
        // 'roll' entries are skipped here: the terminal shows rolls in its own
        // always-mounted DiceLine card (a fixed layout suits a TUI), so letting
        // them into the log too would print every roll twice. The web client has
        // no such card and renders them inline instead.
        onStoryAppend: (entry) => setEntries((prev) => (entry.kind === 'roll' ? prev : [...prev, entry])),
        onStreamText: (text) => setPartial(text),
        onStateChange: (nextState) => {
          stateRef.current = nextState;
          bumpStateVersion();
        },
        onDiceRoll: (message) => setDiceMessage(message),
        onBusyChange: (b) => setBusy(b),
        onSystemNote: (note) => appendSystemEntry(note),
        onRollPrompt: (request) => setPendingRoll(request),
        // Fires once, synchronously, before start() sends anything to the DM
        // on resume/new-hero -- replaces the setEntries([]) above with the
        // player's actual prior scene instead of leaving the log blank.
        onHistoryReplay: (replayed) => setEntries((prev) => [...prev, ...replayed.filter((e) => e.kind !== 'roll')]),
      },
      { debug },
    );

    controllerRef.current = controller;
    setMode('game');
    controller.start(gameMode);
  }

  /** Switches to the wizard: `retireState` non-null means /retire (skip name/theme/rating); null means "New campaign". */
  function enterWizard(retireState: GameState | null): void {
    setPendingRetire(retireState);
    setMode('wizard');
  }

  async function quit(): Promise<void> {
    await controllerRef.current?.shutdown();
    process.exit(0);
  }

  async function handleSlashCommand(raw: string): Promise<void> {
    const trimmed = raw.trim();
    const command = trimmed.toLowerCase();
    const controller = controllerRef.current;
    const state = stateRef.current;

    switch (command) {
      case '/help':
        appendSystemEntry(formatHelp());
        return;
      case '/sheet':
        if (state) appendSystemEntry(formatCharacterSheet(state));
        return;
      case '/journal':
        if (state) appendSystemEntry(formatJournal(state.chronicle));
        return;
      case '/save':
        controller?.forceSave();
        appendSystemEntry('Saved.');
        return;
      case '/quit':
        await quit();
        return;
      case '/retire':
        await controller?.shutdown();
        enterWizard(state);
        return;
      default:
        appendSystemEntry(unknownCommandNote(trimmed));
    }
  }

  function handleSubmit(text: string): void {
    if (text.trim().startsWith('/')) {
      void handleSlashCommand(text);
      return;
    }
    controllerRef.current?.submitPlayerAction(text);
  }

  if (dimensions.columns < MIN_COLUMNS || dimensions.rows < MIN_ROWS) {
    return (
      <Box width={dimensions.columns} height={dimensions.rows} alignItems="center" justifyContent="center">
        <Text color="yellow">Terminal too small — resize to at least 80×20</Text>
      </Box>
    );
  }

  if (mode === 'menu') {
    return (
      <Menu
        onContinue={(slug) => enterGame(loadGame(slug), 'resume')}
        onLoad={(slug) => enterGame(loadGame(slug), 'resume')}
        onNew={() => enterWizard(null)}
        onQuit={() => process.exit(0)}
      />
    );
  }

  if (mode === 'wizard') {
    return (
      <Wizard
        mode={pendingRetire ? 'retire' : 'new'}
        existingState={pendingRetire ?? undefined}
        onCancel={() => {
          setPendingRetire(null);
          setMode('menu');
        }}
        onComplete={(state) => {
          const startMode: GameStartMode = pendingRetire ? 'new-hero' : 'new';
          setPendingRetire(null);
          enterGame(state, startMode);
        }}
      />
    );
  }

  const state = stateRef.current;
  const controller = controllerRef.current;
  if (!state || !controller) {
    return <Text>Loading…</Text>;
  }

  // Explicit widths on BOTH columns (not flexGrow) so a long streaming line
  // can never squeeze the sidebar narrower; explicit story height so the
  // whole frame's total height is exactly dimensions.rows, always -- see
  // computeStoryHeight (./layout.ts) for the row budget this is built from.
  const storyWidth = dimensions.columns - SIDEBAR_WIDTH;
  const storyHeight = computeStoryHeight(dimensions.rows);

  return (
    <Box flexDirection="row" height={dimensions.rows}>
      <Box flexDirection="column" width={storyWidth} height={dimensions.rows}>
        <StoryLog entries={entries} partial={partial} width={storyWidth} height={storyHeight} inputActive={!busy} />
        <Box flexDirection="column" height={DICE_AREA_HEIGHT}>
          <DiceLine
            request={pendingRoll}
            fallbackMessage={diceMessage}
            onConfirm={() => controller.confirmRoll()}
            onResolveLuck={(useLuck) => controller.resolvePendingRoll(useLuck)}
          />
        </Box>
        <InputBar
          busy={busy}
          rollPending={pendingRoll !== null}
          onSubmit={handleSubmit}
          onInterrupt={() => {
            void controller.interrupt();
          }}
        />
      </Box>
      <Sidebar state={state} width={SIDEBAR_WIDTH} />
    </Box>
  );
}
