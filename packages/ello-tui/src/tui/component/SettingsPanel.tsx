import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';

import type { SettingUpdate, TuiSetting } from '../settings/types.js';
import { useTheme } from '../theme/index.js';
import { InlineSelect } from '../ui/List.js';

import { Composer } from './Composer.js';

type PanelState =
  | { readonly type: 'list' }
  | { readonly type: 'actions'; readonly setting: TuiSetting }
  | {
      readonly type: 'edit';
      readonly setting: TuiSetting;
      readonly source: 'global' | 'project';
    };

export function SettingsPanel({
  settings,
  onUpdate,
}: {
  readonly settings: readonly TuiSetting[];
  onUpdate(update: SettingUpdate): Promise<void>;
}) {
  const theme = useTheme();
  const [query, setQuery] = useState('');
  const [state, setState] = useState<PanelState>({ type: 'list' });
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const filtered = useMemo(
    () => filterSettings(settings, query),
    [query, settings],
  );

  useInput(
    (input, key) => {
      if (key.backspace || key.delete) {
        setQuery((current) => current.slice(0, -1));
        return;
      }
      if (
        !key.ctrl &&
        !key.meta &&
        !key.return &&
        !key.upArrow &&
        !key.downArrow &&
        input.length > 0
      ) {
        setQuery((current) => current + input);
      }
    },
    { isActive: state.type === 'list' && !submitting },
  );

  const submit = async (update: SettingUpdate): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await onUpdate(update);
      setState({ type: 'list' });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.markdownHeading}
      paddingX={1}
    >
      <Text color={theme.markdownHeading}>Settings</Text>
      {state.type === 'list' ? (
        <SettingsList
          settings={filtered}
          query={query}
          active={!submitting}
          onSelect={(setting) => {
            setError(undefined);
            setState({ type: 'actions', setting });
          }}
        />
      ) : null}
      {state.type === 'actions' ? (
        <SettingActions
          setting={state.setting}
          active={!submitting}
          onEdit={(source) =>
            setState({ type: 'edit', setting: state.setting, source })
          }
          onReset={(source) =>
            void submit({
              setting: state.setting,
              source,
              operation: 'delete',
            })
          }
        />
      ) : null}
      {state.type === 'edit' ? (
        <SettingEditor
          key={`${state.setting.id}:${state.source}`}
          setting={state.setting}
          source={state.source}
          active={!submitting}
          onSubmit={(value) =>
            void submit({
              setting: state.setting,
              source: state.source,
              operation: 'set',
              value,
            })
          }
          onError={setError}
        />
      ) : null}
      {submitting ? <Text color={theme.textMuted}>Saving…</Text> : null}
      {error !== undefined ? <Text color={theme.error}>{error}</Text> : null}
      <Text color={theme.textMuted}>Esc closes settings</Text>
    </Box>
  );
}

function SettingsList({
  settings,
  query,
  active,
  onSelect,
}: {
  readonly settings: readonly TuiSetting[];
  readonly query: string;
  readonly active: boolean;
  onSelect(setting: TuiSetting): void;
}) {
  return (
    <Box flexDirection="column">
      <Text>{`Search: ${query}_`}</Text>
      <InlineSelect
        key={query}
        label="settings"
        visibleRows={10}
        isActive={active}
        options={
          settings.length === 0
            ? [{ value: '', label: 'No matching settings', disabled: true }]
            : settings.map((setting) => ({
                value: setting.id,
                label: `[${setting.group}] ${displayPath(setting)} = ${settingValue(setting)}  ${setting.source} · ${effectLabel(setting.effect)}`,
              }))
        }
        onChange={(id) => {
          const setting = settings.find((candidate) => candidate.id === id);
          if (setting !== undefined) onSelect(setting);
        }}
      />
      <Text>Type to search · ↑↓ navigate · Enter edit</Text>
    </Box>
  );
}

function SettingActions({
  setting,
  active,
  onEdit,
  onReset,
}: {
  readonly setting: TuiSetting;
  readonly active: boolean;
  onEdit(source: 'global' | 'project'): void;
  onReset(source: 'global' | 'project'): void;
}) {
  const theme = useTheme();
  const actions = setting.writableScopes.flatMap((source) => [
    { value: `set:${source}`, label: `Set ${source}` },
    { value: `delete:${source}`, label: `Reset ${source}` },
  ]);
  return (
    <Box flexDirection="column">
      <Text color={theme.info}>{`${setting.group} / ${displayPath(setting)}`}</Text>
      <Text wrap="wrap">{setting.description}</Text>
      <Text color={theme.textMuted}>{`Current: ${settingValue(setting)} · source ${setting.source} · applies ${effectLabel(setting.effect)}`}</Text>
      <InlineSelect
        key={`actions:${setting.id}`}
        isActive={active}
        options={actions}
        onChange={(value) => {
          const [operation, source] = value.split(':') as [
            'set' | 'delete',
            'global' | 'project',
          ];
          if (operation === 'set') onEdit(source);
          else onReset(source);
        }}
      />
    </Box>
  );
}

function SettingEditor({
  setting,
  source,
  active,
  onSubmit,
  onError,
}: {
  readonly setting: TuiSetting;
  readonly source: 'global' | 'project';
  readonly active: boolean;
  onSubmit(value: unknown): void;
  onError(message: string | undefined): void;
}) {
  const theme = useTheme();
  const options = editorOptions(setting);
  return (
    <Box flexDirection="column">
      <Text color={theme.info}>{`${displayPath(setting)} → ${source}`}</Text>
      <Text wrap="wrap">{setting.description}</Text>
      {options !== undefined ? (
        <InlineSelect
          isActive={active}
          options={options.map((value) => ({ value, label: value }))}
          onChange={(value) => onSubmit(setting.type === 'boolean' ? value === 'true' : value)}
        />
      ) : setting.sensitive ? (
        <SecretInput
          active={active}
          onSubmit={(text) => {
            try {
              onError(undefined);
              onSubmit(parseSettingValue(setting, text));
            } catch (caught) {
              onError(caught instanceof Error ? caught.message : String(caught));
            }
          }}
        />
      ) : (
        <TextValueInput
          active={active}
          initialValue={editableValue(setting)}
          onSubmit={(text) => {
            try {
              onError(undefined);
              onSubmit(parseSettingValue(setting, text));
            } catch (caught) {
              onError(caught instanceof Error ? caught.message : String(caught));
            }
          }}
        />
      )}
    </Box>
  );
}

function TextValueInput({
  active,
  initialValue,
  onSubmit,
}: {
  readonly active: boolean;
  readonly initialValue: string;
  onSubmit(value: string): void;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <Composer
      isActive={active}
      running={false}
      value={value}
      onChange={setValue}
      onSubmit={onSubmit}
      onCancel={() => undefined}
      onEscape={() => undefined}
    />
  );
}

function SecretInput({
  active,
  onSubmit,
}: {
  readonly active: boolean;
  onSubmit(value: string): void;
}) {
  const theme = useTheme();
  const [value, setValue] = useState('');
  useInput(
    (input, key) => {
      if (key.backspace || key.delete) {
        setValue((current) => current.slice(0, -1));
      } else if (key.return) {
        onSubmit(value);
      } else if (!key.ctrl && !key.meta && input.length > 0) {
        setValue((current) => current + input);
      }
    },
    { isActive: active },
  );
  return (
    <Box flexDirection="column">
      <Text color={theme.textMuted}>Current value is hidden.</Text>
      <Text>{`Value: ${'•'.repeat(value.length)}_`}</Text>
    </Box>
  );
}

function filterSettings(
  settings: readonly TuiSetting[],
  query: string,
): readonly TuiSetting[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === '') return settings;
  const terms = normalized.split(/\s+/u);
  return settings.filter((setting) => {
    const haystack = [
      setting.id,
      setting.path.join('.'),
      setting.label,
      setting.description,
      setting.group,
      settingValue(setting),
    ]
      .join(' ')
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

function settingValue(setting: TuiSetting): string {
  if (setting.sensitive) return '••••';
  if (setting.value === undefined) return '<unset>';
  if (typeof setting.value === 'string') return setting.value;
  return JSON.stringify(setting.value);
}

function displayPath(setting: TuiSetting): string {
  return setting.owner === 'client' ? setting.id : setting.path.join('.');
}

function editableValue(setting: TuiSetting): string {
  if (setting.value === undefined || setting.value === null) return '';
  if (setting.type === 'string') return String(setting.value);
  return JSON.stringify(setting.value);
}

function editorOptions(setting: TuiSetting): readonly string[] | undefined {
  const options =
    setting.type === 'boolean'
      ? ['true', 'false']
      : setting.type === 'enum'
        ? [...(setting.options ?? [])]
        : undefined;
  if (options === undefined) return undefined;
  const current = String(setting.value);
  return options.includes(current)
    ? [current, ...options.filter((value) => value !== current)]
    : options;
}

function parseSettingValue(setting: TuiSetting, text: string): unknown {
  if (setting.type === 'string' || setting.type === 'secret') return text;
  if (setting.type === 'integer') {
    const value = Number(text);
    if (!Number.isSafeInteger(value)) throw new Error('Enter a valid integer.');
    return value;
  }
  if (setting.type === 'number') {
    const value = Number(text);
    if (!Number.isFinite(value)) throw new Error('Enter a valid number.');
    return value;
  }
  if (setting.type === 'stringList') {
    if (text.trim().startsWith('[')) {
      const value = JSON.parse(text) as unknown;
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
        throw new Error('Enter a JSON string array.');
      return value;
    }
    return text
      .split(/[\n,]/u)
      .map((item) => item.trim())
      .filter((item) => item !== '');
  }
  if (setting.type === 'json') return JSON.parse(text) as unknown;
  return text;
}

function effectLabel(effect: TuiSetting['effect']): string {
  switch (effect) {
    case 'nextTurn':
      return 'next turn';
    case 'newThread':
      return 'new thread';
    default:
      return effect;
  }
}
