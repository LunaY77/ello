export interface ProviderRequest {
  modelName: string;
  baseUrl: string | null;
  payload?: unknown;
}

export interface ProviderResponse {
  modelName: string;
  status?: number;
  body?: unknown;
}

export interface ProviderHooks {
  beforeRequest?: (request: ProviderRequest) => Promise<ProviderRequest | void>;
  beforePayload?: (payload: unknown) => Promise<unknown | void>;
  afterResponse?: (response: ProviderResponse) => Promise<void>;
}
