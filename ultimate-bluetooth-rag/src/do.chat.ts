// Optional Durable Object for ordered chat updates (not enabled by default)
export class ChatSessionDO {
  state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }
  async fetch(_request: Request): Promise<Response> {
    return new Response(JSON.stringify({ ok: false, error: "Not implemented" }), { status: 501, headers: { "content-type": "application/json" } });
  }
}

export interface DurableObjectState {
  storage: DurableObjectStorage;
}
export interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}


