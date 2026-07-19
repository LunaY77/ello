export const PROFILE_ROLES = [
  'primary',
  'small',
  'compact',
  'title',
  'review',
] as const;

export type ProfileRole = (typeof PROFILE_ROLES)[number];

export interface TuiProfile {
  readonly id: string;
  readonly name: string;
  readonly label?: string;
  readonly description?: string;
  readonly models: Readonly<Record<ProfileRole, string>>;
  readonly raw: Readonly<Record<string, unknown>>;
}
