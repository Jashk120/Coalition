export type GraphClientOptions = {
  /** Subgraph endpoint URL. Always injected — never hardcoded. */
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
};

export type GraphClient = {
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
};

/**
 * Create a subgraph client. The endpoint is always caller-supplied so no
 * Studio URL, deployment ID, or API key is ever baked into the SDK.
 */
export function createGraphClient(options: GraphClientOptions): GraphClient {
  if (options.endpoint.length === 0) {
    throw new Error("endpoint must not be empty");
  }
  return {
    endpoint: options.endpoint,
    headers: {
      "content-type": "application/json",
      ...(options.apiKey === undefined
        ? {}
        : { authorization: `Bearer ${options.apiKey}` }),
    },
    timeoutMs: options.timeoutMs ?? 10_000,
  };
}
