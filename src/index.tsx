// CLI entry point. `--render-check` renders the app for a moment and exits --
// used by the build gate to verify the TUI paints without ever spending an
// AI-billed turn (the menu never constructs a GameController/DmSession).
import { render } from 'ink';
import { App } from './ui/App';
import { loadSettings } from './game/settings';

const RENDER_CHECK_MS = 600;
const debug = process.argv.includes('--debug');

// Ensure settings.json exists (self-healing on first boot) before the UI
// mounts. Any malformed-file warning is surfaced later, in-fiction, once a
// DM session actually starts (DmSession.start() re-reads it) -- there's no
// story log to show a note in yet at this point.
loadSettings();

function runRenderCheck(): void {
  const instance = render(<App debug={debug} />);
  setTimeout(() => {
    instance.unmount();
    console.log('RENDER CHECK OK');
    process.exit(0);
  }, RENDER_CHECK_MS);
}

if (process.argv.includes('--render-check')) {
  runRenderCheck();
} else {
  render(<App debug={debug} />);
}
