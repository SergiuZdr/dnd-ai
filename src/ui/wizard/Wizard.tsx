// Character-creation wizard: name -> hero -> class -> race -> background ->
// stats -> theme -> content rating -> confirm. Esc on any step goes back one
// step (menu from the first step); the confirm screen's Esc restarts the
// wizard from the top instead (its previously-entered answers stay
// pre-filled, so "restart" means "revisit", not "erase").
//
// `/retire` reuses this same wizard in mode 'retire': the world already
// exists, so the campaign-name, theme, and content-rating steps are skipped
// entirely -- it starts at 'hero' and jumps straight from stats to 'confirm',
// collecting only a fresh hero (name/class/race/background/stats) for the
// same persistent campaign/world/chronicle (see createNewHero).
import { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { GameState, Stats } from '../../game/state';
import {
  CLASS_PRESETS,
  RACES,
  BACKGROUNDS,
  THEMES,
  STANDARD_ARRAY,
  createNewCampaign,
  createNewHero,
  assignStats,
  applyRaceBonuses,
} from '../../game/newCampaign';
import type { ClassPreset } from '../../game/newCampaign';
import { saveGame, appendTranscript } from '../../game/saves';
import { SelectList } from '../SelectList';
import type { SelectOption } from '../SelectList';
import { useRawModeActive } from '../useRawModeActive';
import { TextPrompt } from './TextPrompt';
import { StatsRollStep } from './StatsRollStep';

export interface WizardProps {
  /** 'retire' skips campaign-name/theme/content-rating -- the world already exists. Default 'new'. */
  mode?: 'new' | 'retire';
  /** Required when mode === 'retire': the campaign/world/chronicle the new hero joins. */
  existingState?: GameState;
  onCancel: () => void;
  onComplete: (state: GameState) => void;
}

type Step =
  | 'name'
  | 'hero'
  | 'class'
  | 'race'
  | 'background'
  | 'statsMethod'
  | 'statsRoll'
  | 'theme'
  | 'themeCustom'
  | 'contentRating'
  | 'confirm';

/** "front-line weapon master. d10 HP · STR · Sword, Shield, Chainmail, Rations ×5" */
function describeClass(preset: ClassPreset): string {
  const keyStat = preset.statPriority[0].toUpperCase();
  const kit = preset.starterItems.map((item) => (item.qty > 1 ? `${item.name} ×${item.qty}` : item.name)).join(', ');
  return `${preset.tagline}. d${preset.hitBase} HP · ${keyStat} · ${kit}`;
}

function formatStats(stats: Stats): string {
  return (
    `STR ${stats.str}  DEX ${stats.dex}  CON ${stats.con}  ` + `INT ${stats.int}  WIS ${stats.wis}  CHA ${stats.cha}`
  );
}

function ConfirmPrompt({ onConfirm, onBack }: { onConfirm: () => void; onBack: () => void }) {
  const isActive = useRawModeActive();
  useInput(
    (_input, key) => {
      if (key.return) onConfirm();
      else if (key.escape) onBack();
    },
    { isActive },
  );
  return <Text dimColor>Enter to begin your adventure · Esc to start over</Text>;
}

export function Wizard({ mode = 'new', existingState, onCancel, onComplete }: WizardProps) {
  const isRetire = mode === 'retire';
  const [step, setStep] = useState<Step>(isRetire ? 'hero' : 'name');
  const [name, setName] = useState('My Campaign');
  const [heroName, setHeroName] = useState('');
  const [classId, setClassId] = useState('');
  const [race, setRace] = useState('');
  const [backgroundId, setBackgroundId] = useState('');
  const [statValues, setStatValues] = useState<number[]>(STANDARD_ARRAY);
  const [themeSeed, setThemeSeed] = useState('');
  const [themeLabel, setThemeLabel] = useState('');
  const [contentRating, setContentRating] = useState<'PG-13' | 'R'>('PG-13');
  /** After stats: retire skips theme + content rating entirely (the world already has both). */
  const afterStatsStep: Step = isRetire ? 'confirm' : 'theme';

  const classPreset = useMemo(() => CLASS_PRESETS.find((p) => p.id === classId), [classId]);
  const statPriority = classPreset?.statPriority ?? (['str', 'dex', 'con', 'int', 'wis', 'cha'] as const);

  const classOptions = useMemo<SelectOption<string>[]>(
    () =>
      CLASS_PRESETS.map((preset) => ({
        key: preset.id,
        label: preset.name,
        value: preset.id,
        description: describeClass(preset),
      })),
    [],
  );

  const raceOptions = useMemo<SelectOption<string>[]>(
    () => RACES.map((r) => ({ key: r.id, label: r.name, value: r.name, description: r.description })),
    [],
  );

  const backgroundOptions = useMemo<SelectOption<string>[]>(
    () => BACKGROUNDS.map((b) => ({ key: b.id, label: b.name, value: b.id, description: b.description })),
    [],
  );

  const statsMethodOptions = useMemo<SelectOption<'standard' | 'roll'>[]>(
    () => [
      {
        key: 'standard',
        label: 'Standard array',
        description: `[${STANDARD_ARRAY.join(', ')}]`,
        value: 'standard',
      },
      { key: 'roll', label: 'Roll 4d6, drop lowest', value: 'roll' },
    ],
    [],
  );

  const themeOptions = useMemo<SelectOption<string>[]>(
    () => THEMES.map((t) => ({ key: t.id, label: t.label, value: t.id })),
    [],
  );

  const contentRatingOptions = useMemo<SelectOption<'PG-13' | 'R'>[]>(
    () => [
      { key: 'pg13', label: 'PG-13 (default)', value: 'PG-13' },
      { key: 'r', label: 'R (mature)', value: 'R' },
    ],
    [],
  );

  switch (step) {
    case 'name':
      return (
        <TextPrompt
          title="Campaign name"
          initialValue={name}
          placeholder="My Campaign"
          onSubmit={(value) => {
            setName(value);
            setStep('hero');
          }}
          onBack={onCancel}
        />
      );

    case 'hero':
      return (
        <TextPrompt
          title="Hero name"
          initialValue={heroName}
          placeholder="Theron"
          onSubmit={(value) => {
            setHeroName(value);
            setStep('class');
          }}
          onBack={isRetire ? onCancel : () => setStep('name')}
        />
      );

    case 'class':
      return (
        <Box flexDirection="column" padding={1}>
          <Text bold>Choose a class</Text>
          <Box marginTop={1}>
            <SelectList
              options={classOptions}
              onSelect={(id) => {
                setClassId(id);
                setStep('race');
              }}
              onBack={() => setStep('hero')}
            />
          </Box>
        </Box>
      );

    case 'race':
      return (
        <Box flexDirection="column" padding={1}>
          <Text bold>Choose a race</Text>
          <Box marginTop={1}>
            <SelectList
              options={raceOptions}
              onSelect={(r) => {
                setRace(r);
                setStep('background');
              }}
              onBack={() => setStep('class')}
            />
          </Box>
        </Box>
      );

    case 'background':
      return (
        <Box flexDirection="column" padding={1}>
          <Text bold>Choose a background</Text>
          <Box marginTop={1}>
            <SelectList
              options={backgroundOptions}
              onSelect={(id) => {
                setBackgroundId(id);
                setStep('statsMethod');
              }}
              onBack={() => setStep('race')}
            />
          </Box>
        </Box>
      );

    case 'statsMethod':
      return (
        <Box flexDirection="column" padding={1}>
          <Text bold>Choose how to determine ability scores</Text>
          <Box marginTop={1}>
            <SelectList
              options={statsMethodOptions}
              onSelect={(method) => {
                if (method === 'standard') {
                  setStatValues(STANDARD_ARRAY);
                  setStep(afterStatsStep);
                } else {
                  setStep('statsRoll');
                }
              }}
              onBack={() => setStep('background')}
            />
          </Box>
        </Box>
      );

    case 'statsRoll':
      return (
        <StatsRollStep
          priority={[...statPriority]}
          onAccept={(values) => {
            setStatValues(values);
            setStep(afterStatsStep);
          }}
          onBack={() => setStep('statsMethod')}
        />
      );

    case 'theme':
      return (
        <Box flexDirection="column" padding={1}>
          <Text bold>Choose a world theme</Text>
          <Box marginTop={1}>
            <SelectList
              options={themeOptions}
              onSelect={(id) => {
                const preset = THEMES.find((t) => t.id === id);
                if (!preset) return;
                setThemeLabel(preset.label);
                if (preset.id === 'custom') {
                  setStep('themeCustom');
                } else {
                  setThemeSeed(preset.seed);
                  setStep('contentRating');
                }
              }}
              onBack={() => setStep('statsMethod')}
            />
          </Box>
        </Box>
      );

    case 'themeCustom':
      return (
        <TextPrompt
          title="Describe your custom world theme"
          initialValue={themeSeed}
          placeholder="a rain-soaked cyberpunk fantasy"
          onSubmit={(value) => {
            setThemeSeed(value);
            setStep('contentRating');
          }}
          onBack={() => setStep('theme')}
        />
      );

    case 'contentRating':
      return (
        <Box flexDirection="column" padding={1}>
          <Text bold>Choose a content rating</Text>
          <Box marginTop={1}>
            <SelectList
              options={contentRatingOptions}
              onSelect={(rating) => {
                setContentRating(rating);
                setStep('confirm');
              }}
              onBack={() => setStep('theme')}
            />
          </Box>
        </Box>
      );

    case 'confirm': {
      // Base = straight off the stat-roll/array step; final = with the
      // race's bonuses applied on top -- shown side by side so the player
      // sees exactly what their race added.
      const baseStats = assignStats(statValues, [...statPriority]);
      const finalStats = applyRaceBonuses(baseStats, race);
      const background = BACKGROUNDS.find((b) => b.id === backgroundId);
      const restartStep: Step = isRetire ? 'hero' : 'name';
      return (
        <Box flexDirection="column" padding={1}>
          <Text bold>{isRetire ? 'Ready to raise a new hero?' : 'Ready to begin?'}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text>{`Campaign: ${isRetire ? (existingState?.campaign.name ?? '') : name}`}</Text>
            <Text>{`Hero: ${heroName} — ${race} ${classPreset?.name ?? classId}`}</Text>
            <Text dimColor>{`Base stats:  ${formatStats(baseStats)}`}</Text>
            <Text>{`Final stats: ${formatStats(finalStats)}`}</Text>
            {background && <Text>{`Background: ${background.name} — ${background.description}`}</Text>}
            {isRetire ? (
              <Text>{`World: ${existingState?.world.theme ?? ''}`}</Text>
            ) : (
              <>
                <Text>{`Theme: ${themeLabel} (${themeSeed})`}</Text>
                <Text>{`Rating: ${contentRating}`}</Text>
              </>
            )}
          </Box>
          <Box marginTop={1}>
            <ConfirmPrompt
              onConfirm={() => {
                if (isRetire && existingState) {
                  const state = createNewHero(existingState, { heroName, classId, race, backgroundId, statValues });
                  saveGame(state);
                  appendTranscript(state.campaign.slug, {
                    role: 'system',
                    text: `A new hero rises: ${heroName} the ${race} ${classPreset?.name ?? classId}.`,
                    ts: new Date().toISOString(),
                  });
                  onComplete(state);
                } else {
                  const state = createNewCampaign({
                    name,
                    heroName,
                    classId,
                    race,
                    backgroundId,
                    statValues,
                    themeSeed,
                    contentRating,
                  });
                  saveGame(state);
                  onComplete(state);
                }
              }}
              onBack={() => setStep(restartStep)}
            />
          </Box>
        </Box>
      );
    }

    default:
      return null;
  }
}
