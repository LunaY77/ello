export interface ArtifactStore {
  writeJson(path: string, value: unknown): Promise<void>;
  writeText(path: string, value: string): Promise<void>;
  read(path: string): Promise<Uint8Array>;
}
