import React from 'react';

import type { TuiState } from '../state/index.js';

import { CommandPalette } from './CommandPalette.js';
import { ModelPicker } from './ModelPicker.js';
import { SessionPicker } from './SessionPicker.js';
import { SettingsPanel } from './SettingsPanel.js';

/**
 * 选择在 transcript 上方展示哪个浮层。
 */
export function Overlay(props: { state: TuiState }) {
  if (props.state.overlay === 'sessions') {
    return (
      <SessionPicker
        sessions={props.state.sessions}
        selectedIndex={props.state.sessionIndex}
      />
    );
  }
  if (props.state.overlay === 'model') {
    return <ModelPicker models={props.state.models} selectedIndex={props.state.modelIndex} />;
  }
  if (props.state.overlay === 'settings') {
    return <SettingsPanel state={props.state} />;
  }
  if (props.state.overlay === 'commands') {
    return <CommandPalette />;
  }
  return null;
}
