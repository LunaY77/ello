import type { Dispatch, SetStateAction } from 'react';

import type { ThreadClient } from '../../client/thread-client.js';
import {
  loadLocalUiConfig,
  saveLocalUiConfig,
} from '../../config/local-ui-config.js';
import type { OverlayState } from '../component/OverlayHost.js';
import { buildProfileSelectorOptions } from '../model-selectors.js';
import {
  loadSettings,
  profileRoleOptions,
  profilesFromConfig,
  updatedLocalUiConfig,
} from '../profile-config.js';
import type { ProfileRole, TuiProfile } from '../profile-types.js';
import type { SettingUpdate } from '../settings/types.js';
import type { ThemeName } from '../theme/index.js';
import type { SelectOption } from '../ui/List.js';

import { clearTerminalScrollback } from './use-runtime-events.js';

/** Profile/config 写入成功后再发布 UI catalog，避免显示磁盘中不存在的状态。 */
export function useProfileSettings(input: {
  readonly thread: ThreadClient;
  readonly profiles: readonly TuiProfile[];
  readonly activeProfile: string | undefined;
  readonly currentProfile: string;
  readonly modelOptions: readonly SelectOption[];
  readonly themeName: ThemeName;
  setProfiles(profiles: readonly TuiProfile[]): void;
  setConfig(config: unknown): void;
  setOverlay(overlay: OverlayState): void;
  setThemeName(theme: ThemeName): void;
  setThemeEpoch: Dispatch<SetStateAction<number>>;
  onError(error: unknown): void;
}) {
  const applyConfig = (value: unknown): readonly TuiProfile[] => {
    const nextProfiles = profilesFromConfig(value);
    input.setConfig(value);
    input.setProfiles(nextProfiles);
    return nextProfiles;
  };
  const writeGlobalConfig = async (
    path: readonly string[],
    operation: 'set' | 'delete',
    value?: unknown,
  ): Promise<readonly TuiProfile[]> => {
    const result = await input.thread.request('config/write', {
      cwd: input.thread.cwd,
      source: 'global',
      path,
      operation,
      ...(operation === 'set' ? { value } : {}),
    });
    return applyConfig(result.config);
  };
  const showProfiles = (
    profiles: readonly TuiProfile[],
    selectedProfile = input.activeProfile,
  ): void => {
    input.setOverlay({
      type: 'profiles',
      options: buildProfileSelectorOptions(profiles, selectedProfile),
    });
  };
  const showProfile = (profiles: readonly TuiProfile[], name: string): void => {
    const profile = profiles.find((candidate) => candidate.name === name);
    if (profile === undefined) throw new Error(`Unknown profile ${name}.`);
    input.setOverlay({
      type: 'profile-detail',
      profile,
      options: profileRoleOptions(profile),
    });
  };
  const catchError = (promise: Promise<unknown>): void => {
    void promise.catch(input.onError);
  };

  return {
    openProfiles: () => showProfiles(input.profiles),
    openProfile: (name: string) => showProfile(input.profiles, name),
    createProfile: (sourceProfile: string) =>
      input.setOverlay({ type: 'profile-create', sourceProfile }),
    submitNewProfile: (name: string, sourceProfile: string) => {
      const source = input.profiles.find(
        (candidate) => candidate.name === sourceProfile,
      );
      if (source === undefined) {
        input.onError(new Error(`Unknown source profile ${sourceProfile}.`));
        return;
      }
      if (input.profiles.some((candidate) => candidate.name === name)) {
        input.onError(new Error(`Profile ${name} already exists.`));
        return;
      }
      catchError(
        writeGlobalConfig(['profile', name], 'set', source.raw).then((items) =>
          showProfile(items, name),
        ),
      );
    },
    requestDeleteProfile: (profile: string) =>
      input.setOverlay({ type: 'profile-delete-confirm', profile }),
    confirmDeleteProfile: (profile: string) => {
      if (profile === input.activeProfile || profile === input.currentProfile) {
        input.onError(new Error('The active profile cannot be deleted.'));
        return;
      }
      catchError(
        writeGlobalConfig(['profile', profile], 'delete').then((items) =>
          showProfiles(items),
        ),
      );
    },
    activateProfile: (profile: string) => {
      catchError(
        writeGlobalConfig(['active_profile'], 'set', profile).then((items) =>
          showProfiles(items, profile),
        ),
      );
    },
    selectProfileRole: (profileName: string, role: ProfileRole) =>
      input.setOverlay({
        type: 'profile-model-catalog',
        target: { profileName, role },
        options: input.modelOptions,
      }),
    bindProfileRoleModel: (
      profileName: string,
      role: ProfileRole,
      model: string,
    ) => {
      catchError(
        writeGlobalConfig(
          ['profile', profileName, 'models', role],
          'set',
          model,
        ).then((items) => showProfile(items, profileName)),
      );
    },
    saveProfile: (profileName: string) => {
      catchError(
        input.thread
          .request('config/read', {
            cwd: input.thread.cwd,
            includeSources: false,
          })
          .then((result) =>
            showProfile(applyConfig(result.config), profileName),
          ),
      );
    },
    updateSetting: async (update: SettingUpdate): Promise<void> => {
      if (update.setting.owner === 'client') {
        const current = await loadLocalUiConfig();
        const next = updatedLocalUiConfig(current, update);
        const previousTheme = input.themeName;
        if (next.theme !== current.theme) {
          clearTerminalScrollback();
          input.setThemeEpoch((epoch) => epoch + 1);
          input.setThemeName(next.theme);
        }
        try {
          await saveLocalUiConfig(next);
        } catch (error) {
          input.setThemeName(previousTheme);
          throw error;
        }
      } else {
        const result = await input.thread.request('config/write', {
          cwd: input.thread.cwd,
          source: update.source,
          path: update.setting.path,
          operation: update.operation,
          ...(update.operation === 'set' ? { value: update.value } : {}),
        });
        applyConfig(result.config);
      }
      const local = await loadLocalUiConfig();
      input.setOverlay({
        type: 'settings',
        settings: await loadSettings(input.thread, local),
      });
    },
  };
}
