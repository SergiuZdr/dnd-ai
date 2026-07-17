// Every useInput()/<TextInput> in this app must gate on this. Ink's own
// useInput always tries stdin.setRawMode(true) on mount unless explicitly told
// isActive: false, and ink-text-input's <TextInput> defaults its internal
// useInput to isActive: true regardless of the terminal. Under non-TTY stdin
// (piped, --render-check, CI) that throws "Raw mode is not supported..." and
// takes down the whole render. useStdin().isRawModeSupported is `undefined`
// (not `false`) on non-TTY streams, and ink's guard is a strict `=== false`
// check, so the value must be coerced to a real boolean here.
import { useStdin } from 'ink';

export function useRawModeActive(): boolean {
  return Boolean(useStdin().isRawModeSupported);
}
