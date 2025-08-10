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
}

// Minimal R2 bucket type (available in Workers runtime)
export interface R2Bucket {
  put(key: string, value: string | ArrayBuffer | ReadableStream, options?: { httpMetadata?: { contentType?: string } }): Promise<void>;
}

export type JsonObject = Record<string, unknown>;

export interface AiBinding {
  run<TInput = unknown, TOutput = unknown>(model: string, input: TInput): Promise<TOutput>;
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