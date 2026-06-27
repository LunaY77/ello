declare module '@ello/tui' {
  export function renderCodingAgentTui(options: {
    config: import('./config.js').CodingAgentConfig;
  }): Promise<void>;
}
