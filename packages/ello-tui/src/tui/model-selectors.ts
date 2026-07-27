import type { ModelCatalogEntry } from '../api/protocol-types.js';

import type { SelectOption } from './ui/List.js';

export function buildModelCatalogOptions(
  models: readonly ModelCatalogEntry[],
  references: { readonly primaryModel: string; readonly auxiliaryModel: string },
): readonly SelectOption[] {
  return models.map((model) => ({
    label: `${model.title ?? model.name}${model.id === references.primaryModel ? ' [primary]' : ''}${model.id === references.auxiliaryModel ? ' [auxiliary]' : ''}`,
    value: model.id,
  }));
}
