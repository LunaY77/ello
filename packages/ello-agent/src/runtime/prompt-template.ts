export function renderSystemPrompt(options: {
  template: string | null;
  templateVars: Record<string, unknown> | null;
  defaultTemplate: string;
}): string {
  const template = options.template ?? options.defaultTemplate;
  if (template.trim().length === 0) {
    return '';
  }
  return renderTemplate(template, options.templateVars ?? {});
}

function renderTemplate(
  template: string,
  vars: Record<string, unknown>,
): string {
  return template
    .replace(
      /\{%\s*if\s+instructions\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/g,
      (_match, block: string) =>
        hasNonEmptyValue(vars.instructions)
          ? block.replace(
              /\{\{\s*instructions\s*\}\}/g,
              String(vars.instructions),
            )
          : '',
    )
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
      const value = vars[key];
      return value === undefined || value === null ? '' : String(value);
    });
}

function hasNonEmptyValue(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}
