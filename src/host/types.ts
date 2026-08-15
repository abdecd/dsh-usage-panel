// dsh-usage-panel · host-side structural types for services the plugin uses
// at runtime but whose host-side type packages are not public: the Cordis
// `connection` service (RPC) and the `llm` service (provider directory).
// The runtime shapes below are exactly what v0.1.0 already exercised.

export interface HostRpcResult<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string; details: Record<string, unknown> }
}

export interface HostRpcHandle {
  handle(
    path: string,
    handler: (endpoint: string, payload: unknown) => Promise<HostRpcResult<unknown>>,
    options: { authority: 'loopback' },
  ): () => void
}

export interface HostConnection {
  rpc: HostRpcHandle
}

export interface LlmProviderInfoLike {
  id: string
  name: string
}

export interface HostLlm {
  listProviders(): Promise<LlmProviderInfoLike[]> | LlmProviderInfoLike[]
}
