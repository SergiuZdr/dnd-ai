// Main menu: Continue / New / Load / Quit. Hand-rolled selection (no new
// dependencies), backed by the save directory listing.
import { useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { latestCampaign, listCampaigns } from '../game/saves';
import { SelectList } from './SelectList';
import type { SelectOption } from './SelectList';

export interface MenuProps {
  onContinue: (slug: string) => void;
  onLoad: (slug: string) => void;
  onNew: () => void;
  onQuit: () => void;
}

type MainAction = 'continue' | 'new' | 'load' | 'quit';

export function Menu({ onContinue, onLoad, onNew, onQuit }: MenuProps) {
  const latest = useMemo(() => latestCampaign(), []);
  const [showLoad, setShowLoad] = useState(false);

  const options = useMemo<SelectOption<MainAction>[]>(() => {
    const opts: SelectOption<MainAction>[] = [];
    if (latest) {
      opts.push({ key: 'continue', label: `Continue — ${latest.name}`, value: 'continue' });
    }
    opts.push({ key: 'new', label: 'New campaign', value: 'new' });
    opts.push({ key: 'load', label: 'Load campaign', value: 'load' });
    opts.push({ key: 'quit', label: 'Quit', value: 'quit' });
    return opts;
  }, [latest]);

  if (showLoad) {
    return <LoadMenu onSelect={onLoad} onBack={() => setShowLoad(false)} />;
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text color="cyan" bold>
        {'⚔️  AI DUNGEON MASTER'}
      </Text>
      <Box marginTop={1}>
        <SelectList
          options={options}
          onSelect={(action) => {
            if (action === 'continue' && latest) onContinue(latest.slug);
            else if (action === 'new') onNew();
            else if (action === 'load') setShowLoad(true);
            else if (action === 'quit') onQuit();
          }}
        />
      </Box>
    </Box>
  );
}

function LoadMenu({ onSelect, onBack }: { onSelect: (slug: string) => void; onBack: () => void }) {
  const campaigns = useMemo(() => listCampaigns(), []);
  const options = useMemo<SelectOption<string>[]>(
    () =>
      campaigns.map((c) => ({
        key: c.slug,
        label: c.name,
        value: c.slug,
        description: `updated ${new Date(c.updatedAt).toLocaleString()}`,
      })),
    [campaigns],
  );

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Load campaign</Text>
      <Box marginTop={1}>
        <SelectList options={options} onSelect={onSelect} onBack={onBack} />
      </Box>
    </Box>
  );
}
