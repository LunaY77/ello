/**
 * UI 组件 barrel。
 *
 * 渲染组件位于 `layout`、`transcript` 和 `panels`；app 层编排从这里导入，
 * 使 React 树无需关心面板的物理目录布局。
 */
export { AppShell } from './Layout.js';
export { Transcript } from './Transcript.js';
export {
  CommandPalette,
  ModelPicker,
  Overlay,
  SettingsPanel,
  SessionPicker,
  StatusBar,
  ToolApprovalPanel,
  ToolCards,
} from './panels/index.js';
