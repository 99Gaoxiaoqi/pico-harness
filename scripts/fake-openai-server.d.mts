export interface FakeOpenAiServer {
  readonly baseURL: string;
  readonly requestCount: number;
  close(): Promise<void>;
}

export function startFakeOpenAiServer(options?: { content?: string }): Promise<FakeOpenAiServer>;
