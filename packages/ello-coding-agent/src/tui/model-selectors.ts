import type { CodingAgentConfig } from '../config/index.js';
import {
  createProviderRegistry,
  type RuntimeModel,
  type RuntimeProfileSuite,
} from '../provider/index.js';

import type { SelectOption } from './ui/List.js';

export function buildProfileSelectorOptions(
  config: CodingAgentConfig,
): readonly SelectOption[] {
  const registry = createProviderRegistry(config);
  const options: SelectOption[] = [groupOption('Profiles')];
  for (const profile of registry.listProfiles()) {
    options.push(profileOption(profile, config));
  }
  return options;
}

export function buildModelCatalogOptions(
  config: CodingAgentConfig,
): readonly SelectOption[] {
  const registry = createProviderRegistry(config);
  const options: SelectOption[] = [];
  for (const provider of registry
    .listProviders()
    .filter(
      (candidate) =>
        candidate.enabled && registry.listModels(candidate.id).length > 0,
    )) {
    options.push(groupOption(provider.name));
    for (const model of registry.listModels(provider.id)) {
      options.push(modelOption(model));
    }
  }
  return options;
}

function groupOption(label: string): SelectOption {
  return { label, value: `group:${label}`, disabled: true };
}

function profileOption(
  profile: RuntimeProfileSuite,
  config: CodingAgentConfig,
): SelectOption {
  const markers = profile.name === config.active_profile ? ' [active]' : '';
  const label = profile.label ?? profile.name;
  const description = profile.description ?? '';
  return {
    label: `  ${profile.name}${markers}  ${label}${description.length > 0 ? `  ${description}` : ''}`,
    value: profile.name,
  };
}

function modelOption(model: RuntimeModel): SelectOption {
  return {
    label: `  ${model.ref}  ctx ${model.limit.context} / out ${model.limit.output}`,
    value: model.ref,
  };
}
