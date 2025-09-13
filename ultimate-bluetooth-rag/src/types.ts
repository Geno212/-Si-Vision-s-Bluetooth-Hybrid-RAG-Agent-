export interface Env {
  AI: AiBinding;
  VECTORIZE_INDEX: VectorizeIndexBinding;
  DOCS_BUCKET: R2Bucket;

  MIN_RANK_SCORE: string;
  TOP_K: string;
  TOP_RERANK: string;

  MODEL_GENERATION: string;
  MODEL_EMBEDDING: string;
  MODEL_RERANK: string;

  SERPER_API_KEY?: string;
  TAVILY_API_KEY?: string;
  API_AUTH_TOKEN?: string;

  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;

  // Reasoning configuration for GPT OSS 120B
  REASONING_EFFORT_COMPLEX?: string;
  REASONING_EFFORT_SYNTHESIS?: string;
  REASONING_EFFORT_VALIDATION?: string;  
  REASONING_SUMMARY_LEVEL?: string;

  // Chat memory bindings (optional; added by conversational feature)
  BT_RAG_CHAT_KV?: KVNamespace;
  CHAT_SESSIONS?: DurableObjectNamespace;
}

// Minimal R2 bucket type (available in Workers runtime)
export interface R2Bucket {
  put(key: string, value: string | ArrayBuffer | ReadableStream, options?: { httpMetadata?: { contentType?: string } }): Promise<void>;
}

export type JsonObject = Record<string, unknown>;

export interface AiBinding {
  run<TInput = unknown, TOutput = unknown>(model: string, input: TInput): Promise<TOutput>;
}

// Minimal KV namespace type (Cloudflare Workers)
export interface KVNamespace {
  get(key: string): Promise<string | null>;
  get<TReturn = unknown>(key: string, type: { type: "json" }): Promise<TReturn | null>;
  put(key: string, value: string, options?: { expirationTtl?: number; expiration?: number; }): Promise<void>;
  delete(key: string): Promise<void>;
}

// Minimal Durable Objects types (optional usage)
export interface DurableObjectId {}
export interface DurableObjectStub {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}
export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  newUniqueId(): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

// Minimal Vectorize binding types
export interface VectorizeIndexBinding {
  upsert(points: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>): Promise<void>;
  query(request: {
    vector: number[];
    topK: number;
    filter?: Record<string, unknown>;
    returnValues?: boolean;
    returnMetadata?: boolean;
  }): Promise<{
    matches: Array<{
      id: string;
      score: number;
      vector?: number[];
      metadata?: Record<string, unknown>;
    }>;
  }>;
}

export interface IngestRequestBody {
  id: string;         // unique doc id (e.g., filename-derived)
  text: string;       // raw extracted text
  title?: string;     // optional human title
  source?: string;    // optional source path/URL
}

export interface QueryRequestBody {
  query: string;
  topK?: number;
  topRerank?: number;
}

export interface RetrievedChunk {
  id: string;
  content: string;
  score: number;
  metadata: {
    doc_id?: string;
    title?: string;
    source?: string;
    chunk_index?: number;
    offset?: number;
    length?: number;
  } & Record<string, unknown>;
} 

// Chat API types
export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  createdAt?: string; // ISO timestamp (optional)
  tokensEstimated?: number; // optional for observability
}

export interface Citation {
  ref: string; // e.g., "#1"
  id: string;
  title?: string;
  source?: string;
}

export interface ChatRequestBody {
  conversationId?: string;
  messages: ChatMessage[];
  stream?: boolean;
  topK?: number;
  topRerank?: number;
  maxIter?: number;
}

export interface ChatResponse {
  conversationId: string;
  answer: string;
  citations: Citation[];
}

// Bluetooth enhancements (stubs)
export interface DeviceRegistryEntry {
  deviceId: string;
  nickname?: string;
  notes?: string;
  lastSeen?: string; // ISO timestamp
}

export interface GattNote {
  deviceId: string;
  serviceUuid?: string;
  characteristicUuid?: string;
  note: string;
  createdAt: string; // ISO timestamp
}

export type BluetoothAction = "scan" | "connect" | "disconnect" | "read" | "write" | "notify";

export interface BluetoothToolRequest {
  action: BluetoothAction;
  params?: Record<string, unknown>;
}

// Enhanced GPT OSS 120B reasoning types
export interface ReasoningParameters {
  effort?: "low" | "medium" | "high";
  summary?: "auto" | "concise" | "detailed";
}

export interface EnhancedGenerationInput {
  input: string | Array<{ role: string; content: string }>;
  reasoning?: ReasoningParameters;
  temperature?: number;
  max_tokens?: number;
}

export interface ReasoningResponse {
  response: string;
  reasoning_summary?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// Agent decision transparency types
export interface AgentDecision {
  agent: string;
  task: string;
  reasoning_effort: string;
  reasoning_summary?: string;
  timestamp: string;
  cost_estimate?: number;
}

export interface BluetoothToolResponse {
  ok: boolean;
  message: string;
  data?: unknown;
}