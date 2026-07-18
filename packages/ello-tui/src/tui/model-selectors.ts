import type {
  CatalogEntry,
  ModelCatalogEntry,
  ProviderCatalogEntry,
} from '../api/protocol-types.js';

import type { SelectOption } from './ui/List.js';

export function buildProfileSelectorOptions(
  profiles: readonly Pick<CatalogEntry, 'id' | 'name'>[],
  activeProfile?: string,
): readonly SelectOption[] {
  const options: SelectOption[] = [groupOption('Profiles')];
  for (const profile of profiles) {
    options.push({
      label: `${profile.name}${profile.name === activeProfile ? ' [active]' : ''}`,
      value: profile.id,
    });
  }
  return options;
}

export function buildModelCatalogOptions(
  models: readonly ModelCatalogEntry[],
  providers: readonly ProviderCatalogEntry[] = [],
): readonly SelectOption[] {
  const options: SelectOption[] = [];
  const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]));
  const groups = new Map<string, ModelCatalogEntry[]>();
  for (const model of models) {
    const provider = typeof model.metadata.provider === 'string'
      ? model.metadata.provider
      : 'Models';
    const group = groups.get(provider) ?? [];
    group.push(model);
    groups.set(provider, group);
  }
  for (const [provider, entries] of groups) {
    options.push(groupOption(providerNames.get(provider) ?? provider));
    for (const model of entries) {
      options.push({
        label: `  ${model.title ?? model.name}`,
        value: model.id,
      });
    }
  }
  return options;
}

function groupOption(label: string): SelectOption {
  return { label, value: `group:${label}`, disabled: true };
}
