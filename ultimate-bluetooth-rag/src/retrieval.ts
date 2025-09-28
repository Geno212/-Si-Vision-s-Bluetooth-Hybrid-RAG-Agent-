import type { Env, RetrievedChunk } from "./types";

// In-memory vector store for local dev when Vectorize is unavailable
interface DevPoint { id: string; values: number[]; metadata?: Record<string, unknown> }
const devVectorStore: DevPoint[] = [];

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function cfAiEmbedViaRest(env: Env, text: string): Promise<number[] | null> {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return null;
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${encodeURIComponent(env.MODEL_EMBEDDING)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) return null;
  const data: any = await res.json();
  const result = data?.result ?? data;
  // BGE-M3 response shape handling
  if (Array.isArray(result?.data) && typeof result.data[0] === "number") return result.data as number[];
  if (Array.isArray(result?.data) && Array.isArray(result.data[0])) return result.data[0] as number[];
  if (Array.isArray(result?.data) && result.data[0]?.embedding) return result.data[0].embedding as number[];
  if (Array.isArray(result?.embeddings)) return result.embeddings[0] as number[];
  if (Array.isArray(result?.output) && Array.isArray(result.output[0])) return result.output[0] as number[];
  return null;
}

// BGE-Large Batch Embedding Function with Enhanced Logging and Rate Limiting
export async function embedTextBatch(env: Env, texts: string[], useQueryPrefix: boolean = false): Promise<number[][]> {
  const MAX_BATCH_SIZE = 50; // Increase batch size for faster processing
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 5000; // 5 seconds for batch operations
  
  console.log(`[EMBEDDING] Starting batch embedding for ${texts.length} texts, max batch size: ${MAX_BATCH_SIZE}`);
  
  const results: number[][] = [];
  
  // Process in smaller batches to respect rate limits
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const batchInputs = batch.map(text => useQueryPrefix ? `query: ${text}` : text);
    
    const batchNumber = Math.floor(i / MAX_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(texts.length / MAX_BATCH_SIZE);
    console.log(`[EMBEDDING] Processing batch ${batchNumber}/${totalBatches} (texts ${i + 1}-${Math.min(i + MAX_BATCH_SIZE, texts.length)}/${texts.length})`);
    console.log(`[EMBEDDING] Batch text lengths: [${batch.map(t => t.length).join(', ')}]`);
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[EMBEDDING] Batch ${batchNumber} attempt ${attempt}/${MAX_RETRIES} - calling ${env.MODEL_EMBEDDING}`);
        const startTime = Date.now();
        
        const res: any = await env.AI.run(env.MODEL_EMBEDDING, { text: batchInputs });
        
        const processingTime = Date.now() - startTime;
        console.log(`[EMBEDDING] API call completed in ${processingTime}ms`);
        
        // Handle batch response - BGE-Large model debugging
        let batchVectors: number[][] = [];
        
        console.log(`[EMBEDDING] Raw response type:`, typeof res);
        console.log(`[EMBEDDING] Raw response keys:`, Object.keys(res || {}));
        // Don't log full response anymore due to 256KB limit - just log structure
        if (res?.data) {
          console.log(`[EMBEDDING] Data type:`, typeof res.data, `Length:`, Array.isArray(res.data) ? res.data.length : 'not array');
          if (Array.isArray(res.data) && res.data.length > 0) {
            console.log(`[EMBEDDING] First element type:`, typeof res.data[0], `Length:`, Array.isArray(res.data[0]) ? res.data[0].length : 'not array');
          }
        }
        console.log(`[EMBEDDING] Shape:`, res?.shape);
        console.log(`[EMBEDDING] Pooling:`, res?.pooling);
        
        // BGE-Large specific format: { data: [...], shape: [...], pooling: [...] }
        
        // Pattern 1: BGE-Large format with data field
        if (Array.isArray(res?.data)) {
          if (Array.isArray(res.data[0]) && typeof res.data[0][0] === "number") {
            // 2D array: [[0.1, 0.2, ...], [0.4, 0.5, ...]]
            batchVectors = res.data as number[][];
            console.log(`[EMBEDDING] ✅ Using BGE-Large res.data 2D array format, found ${batchVectors.length} vectors`);
            console.log(`[EMBEDDING] Shape info:`, res.shape);
            console.log(`[EMBEDDING] Pooling info:`, res.pooling);
          } else if (Array.isArray(res.data[0]) && Array.isArray(res.data[0][0])) {
            // Nested 3D: [[[0.1, 0.2, ...]]]
            batchVectors = res.data[0] as number[][];
            console.log(`[EMBEDDING] ✅ Using BGE-Large res.data nested format, found ${batchVectors.length} vectors`);
          } else if (typeof res.data[0] === "number") {
            // Single flat array for one text: [0.1, 0.2, 0.3, ...]
            batchVectors = [res.data as number[]];
            console.log(`[EMBEDDING] ✅ Using BGE-Large res.data single vector format, found ${batchVectors.length} vectors`);
          } else {
            // Try to reshape based on shape information if available
            if (res.shape && Array.isArray(res.shape) && res.shape.length === 2) {
              const [numVectors, vectorDim] = res.shape;
              console.log(`[EMBEDDING] Attempting reshape using shape: [${numVectors}, ${vectorDim}]`);
              
              // Reshape flat data array
              const flatData = res.data;
              if (Array.isArray(flatData) && flatData.length === numVectors * vectorDim) {
                batchVectors = [];
                for (let i = 0; i < numVectors; i++) {
                  const start = i * vectorDim;
                  const end = start + vectorDim;
                  batchVectors.push(flatData.slice(start, end));
                }
                console.log(`[EMBEDDING] ✅ Using BGE-Large reshape format, found ${batchVectors.length} vectors`);
              }
            }
          }
        }
        
        // Pattern 2: Result wrapper
        else if (Array.isArray(res?.result?.data)) {
          if (Array.isArray(res.result.data[0]) && typeof res.result.data[0][0] === "number") {
            batchVectors = res.result.data as number[][];
            console.log(`[EMBEDDING] ✅ Using res.result.data format, found ${batchVectors.length} vectors`);
          }
        }
        
        // Pattern 3: Response wrapper
        else if (Array.isArray(res?.response)) {
          if (Array.isArray(res.response[0]) && typeof res.response[0][0] === "number") {
            batchVectors = res.response as number[][];
            console.log(`[EMBEDDING] ✅ Using res.response format, found ${batchVectors.length} vectors`);
          }
        }
        
        // Pattern 4: Embeddings field
        else if (Array.isArray(res?.embeddings)) {
          if (Array.isArray(res.embeddings[0]) && typeof res.embeddings[0][0] === "number") {
            batchVectors = res.embeddings as number[][];
            console.log(`[EMBEDDING] ✅ Using res.embeddings format, found ${batchVectors.length} vectors`);
          }
        }
        
        // Pattern 5: Direct array response
        else if (Array.isArray(res)) {
          if (Array.isArray(res[0]) && typeof res[0][0] === "number") {
            batchVectors = res as number[][];
            console.log(`[EMBEDDING] ✅ Using direct array format, found ${batchVectors.length} vectors`);
          }
        }
        
        // Pattern 6: Single vector in data
        else if (res?.data && !Array.isArray(res.data) && typeof res.data[0] === "number") {
          batchVectors = [res.data];
          console.log(`[EMBEDDING] ✅ Using single data vector format, found ${batchVectors.length} vectors`);
        }
        
        console.log(`[EMBEDDING] Extraction complete. Found ${batchVectors.length} vectors total`);
        
        // Validate all vectors
        const validVectors = batchVectors.filter(vec => 
          Array.isArray(vec) && 
          vec.length > 0 && 
          vec.every(n => typeof n === "number" && Number.isFinite(n))
        );
        
        console.log(`[EMBEDDING] Validated ${validVectors.length}/${batchVectors.length} vectors from batch`);
        if (validVectors.length > 0) {
          console.log(`[EMBEDDING] Vector dimensions: ${validVectors[0].length}`);
        }
        
        if (validVectors.length === batch.length) {
          console.log(`[EMBEDDING] Batch ${batchNumber} successful on attempt ${attempt} (${validVectors.length} vectors in ${processingTime}ms)`);
          results.push(...validVectors);
          break;
        }
        
        throw new Error(`Invalid batch response: got ${validVectors.length} valid vectors for ${batch.length} texts`);
        
      } catch (e: any) {
        console.log(`[EMBEDDING] Batch ${batchNumber} attempt ${attempt} failed:`, e.message);
        console.log(`[EMBEDDING] Error details:`, e.stack || e);
        
        if (attempt === MAX_RETRIES) {
          console.log(`[EMBEDDING] Batch ${batchNumber} failed after ${MAX_RETRIES} attempts, falling back to individual embeddings`);
          
          // Fallback to individual embeddings with longer delays
          for (let j = 0; j < batch.length; j++) {
            const text = batch[j];
            try {
              console.log(`[EMBEDDING] Individual processing ${j + 1}/${batch.length} (text length: ${text.length})`);
              const vec = await embedTextSingle(env, text, useQueryPrefix);
              results.push(vec);
              console.log(`[EMBEDDING] Individual embedding ${j + 1} successful (dim: ${vec.length})`);
              // Much longer delay to avoid rate limiting
              await new Promise(resolve => setTimeout(resolve, 5000)); // 5 seconds between individual requests
            } catch (individualError: any) {
              console.log(`[EMBEDDING] Individual embedding ${j + 1} failed:`, individualError.message);
              // Determine vector dimension from previous successful embeddings or default
              const vectorDim = results.length > 0 ? results[0].length : 1024;
              const fallbackVector = new Array(vectorDim).fill(0);
              results.push(fallbackVector);
              console.log(`[EMBEDDING] Using zero vector fallback (dim: ${vectorDim})`);
            }
          }
          break;
        }
        
        // Exponential backoff for batch retries
        const delay = RETRY_DELAY * Math.pow(2, attempt - 1);
        console.log(`Waiting ${delay}ms before batch retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    // Rate limiting delay between batches
    if (i + MAX_BATCH_SIZE < texts.length) {
      console.log(`[EMBEDDING] Pausing 3 seconds before next batch to respect rate limits...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  
  console.log(`[EMBEDDING] Batch embedding completed: ${results.length}/${texts.length} embeddings generated`);
  if (results.length > 0) {
    console.log(`[EMBEDDING] Final vector dimensions: ${results[0].length}`);
  }
  return results;
}

// Single embedding function (fallback) with enhanced logging
export async function embedTextSingle(env: Env, text: string, useQueryPrefix: boolean = false): Promise<number[]> {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 2000; // 2 seconds
  
  console.log(`[EMBEDDING_SINGLE] Processing text (length: ${text.length})`);
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // BGE models support query prefix for enhanced query-context matching
      const inputText = useQueryPrefix ? `query: ${text}` : text;
      
      console.log(`[EMBEDDING_SINGLE] Attempt ${attempt}/${MAX_RETRIES} - calling ${env.MODEL_EMBEDDING}`);
      const startTime = Date.now();
      
      const res: any = await env.AI.run(env.MODEL_EMBEDDING, { text: inputText });
      
      const processingTime = Date.now() - startTime;
      console.log(`[EMBEDDING_SINGLE] API call completed in ${processingTime}ms`);
      
      // Normalize common Workers AI response shapes for BGE models
      let vec: number[] | null = null;
      if (Array.isArray(res?.data) && typeof res.data[0] === "number") vec = res.data as number[];
      else if (Array.isArray(res?.data) && Array.isArray(res.data[0])) vec = res.data[0] as number[];
      else if (Array.isArray(res?.data) && res.data[0]?.embedding) vec = res.data[0].embedding as number[];
      else if (Array.isArray(res?.embeddings)) vec = res.embeddings[0] as number[];
      else if (Array.isArray(res?.output) && Array.isArray(res.output[0])) vec = res.output[0] as number[];
      else if (Array.isArray(res?.result?.data) && typeof res.result.data[0] === "number") vec = res.result.data as number[];
      else if (Array.isArray(res?.result?.data) && Array.isArray(res.result.data[0])) vec = res.result.data[0] as number[];

      // Validate vector: must be non-empty numeric array
      if (Array.isArray(vec) && vec.length > 0 && vec.every((n) => typeof n === "number" && Number.isFinite(n))) {
        console.log(`[EMBEDDING_SINGLE] Success on attempt ${attempt} (dim: ${vec.length}, time: ${processingTime}ms)`);
        return vec;
      }
      
      console.log(`[EMBEDDING_SINGLE] Invalid vector received on attempt ${attempt}`);
      console.log(`[EMBEDDING_SINGLE] Vector info: Array=${Array.isArray(vec)}, Length=${vec?.length}, AllNumbers=${Array.isArray(vec) && vec.every((n: any) => typeof n === "number" && Number.isFinite(n))}`);
    

      // If shape/validation unknown, try REST fallback
      const viaRest = await cfAiEmbedViaRest(env, inputText);
      if (Array.isArray(viaRest) && viaRest.length > 0 && viaRest.every((n) => typeof n === "number" && Number.isFinite(n))) {
        return viaRest;
      }
      
      throw new Error("Embedding returned empty or invalid vector");
      
    } catch (e: any) {
      console.log(`[EMBEDDING_SINGLE] Attempt ${attempt} failed:`, e.message);
      
      if (attempt === MAX_RETRIES) {
        try {
          console.log(`[EMBEDDING_SINGLE] Trying REST API fallback...`);
          const inputText = useQueryPrefix ? `query: ${text}` : text;
          const viaRest = await cfAiEmbedViaRest(env, inputText);
          if (Array.isArray(viaRest) && viaRest.length > 0 && viaRest.every((n) => typeof n === "number" && Number.isFinite(n))) {
            console.log(`[EMBEDDING_SINGLE] REST fallback successful (dim: ${viaRest.length})`);
            return viaRest;
          }
        } catch (restError: any) {
          console.log(`[EMBEDDING_SINGLE] REST fallback failed:`, restError.message);
        }
        // Final fallback: return zero vector
        console.log(`[EMBEDDING_SINGLE] All embedding methods failed, returning zero vector (1024 dim)`);
        return new Array(1024).fill(0);
      }
      
      // Wait before retrying (exponential backoff)
      const delay = RETRY_DELAY * Math.pow(2, attempt - 1);
      console.log(`[EMBEDDING_SINGLE] Waiting ${delay}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  return new Array(1024).fill(0); // Should never reach here
}

// Legacy function for backward compatibility
export async function embedText(env: Env, text: string, useQueryPrefix: boolean = false): Promise<number[]> {
  return embedTextSingle(env, text, useQueryPrefix);
}

// Enhanced BGE-M3 query-context similarity scoring
export function calculateBgeM3Score(queryVec: number[], contextVec: number[], queryText: string, contextText: string): number {
  // Dense retrieval score (cosine similarity)
  const denseScore = cosineSimilarity(queryVec, contextVec);
  
  // Simple lexical matching boost (can be enhanced with proper sparse vectors in future)
  const queryTerms = queryText.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const contextTerms = contextText.toLowerCase().split(/\s+/);
  const termOverlap = queryTerms.filter(qt => contextTerms.some(ct => ct.includes(qt) || qt.includes(ct))).length;
  const lexicalBoost = Math.min(termOverlap / Math.max(queryTerms.length, 1) * 0.1, 0.1);
  
  // Technical term matching bonus for Bluetooth specifications
  const bluetoothTerms = ['bluetooth', 'ble', 'gatt', 'characteristic', 'service', 'uuid', 'descriptor', 'advertising', 'pairing', 'bonding'];
  const techTermMatches = bluetoothTerms.filter(term => 
    queryText.toLowerCase().includes(term) && contextText.toLowerCase().includes(term)
  ).length;
  const techBoost = Math.min(techTermMatches * 0.05, 0.15);
  
  return Math.min(denseScore + lexicalBoost + techBoost, 1.0);
}

export async function rerank(env: Env, query: string, passages: string[]): Promise<{ index: number; score: number }[]> {
  if (passages.length === 0) return [];

  const parse = (res: any): Array<{ index: number; score: number }> => {
    if (!res) return [];
    const candidates = res?.results ?? res?.data ?? res?.output ?? res?.result?.results ?? res?.result?.data ?? [];
    if (Array.isArray(candidates)) {
      return candidates.map((r: any, i: number) => ({
        index: Number(r?.index ?? r?.document ?? r?.doc ?? i) || 0,
        score: Number(r?.relevance_score ?? r?.score ?? r?.relevance ?? 0) || 0,
      }));
    }
    return [];
  };

  const attempts: Array<() => Promise<any>> = [
    () => env.AI.run(env.MODEL_RERANK, { query, documents: passages }),
    () => env.AI.run(env.MODEL_RERANK, { query, contexts: passages }),
    () => env.AI.run(env.MODEL_RERANK, { query, inputs: passages }),
    () => env.AI.run(env.MODEL_RERANK, { input: { query, documents: passages } }),
    () => env.AI.run(env.MODEL_RERANK, { input: { query, contexts: passages } }),
  ];

  for (const attempt of attempts) {
    try {
      const res = await attempt();
      const ranked = parse(res);
      if (ranked.length > 0) return ranked;
    } catch {
      // try next shape
    }
  }

  // Fallback: keep original order with zero scores
  return passages.map((_, i) => ({ index: i, score: 0 }));
}

export function numericEnv(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export async function webSearchSerper(env: Env, query: string): Promise<{ context: string; sources: Array<{ title: string; link: string }>; } | null> {
  const key = env.SERPER_API_KEY;
  if (!key) return null;
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": key,
    },
    body: JSON.stringify({ q: query }),
  });
  if (!res.ok) return null;
  const data: any = await res.json();
  const items: any[] = data?.organic ?? [];
  const top = items.slice(0, 5).map((it) => ({ title: it.title, link: it.link, snippet: it.snippet }));
  const ctx = top.map((t, i) => `[W${i + 1}] ${t.title}\n${t.snippet}\n${t.link}`).join("\n\n");
  return { context: ctx, sources: top.map(({ title, link }) => ({ title, link })) };
}

export async function webSearchTavily(env: Env, query: string): Promise<{ context: string; sources: Array<{ title: string; link: string }>; } | null> {
  const key = env.TAVILY_API_KEY;
  if (!key) return null;
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({ query, include_answer: false, max_results: 5 }),
  });
  if (!res.ok) return null;
  const data: any = await res.json();
  const results: any[] = data?.results ?? [];
  const top = results.slice(0, 5).map((r) => ({ title: r.title, link: r.url, snippet: r.content }));
  const ctx = top.map((t, i) => `[W${i + 1}] ${t.title}\n${t.snippet}\n${t.link}`).join("\n\n");
  return { context: ctx, sources: top.map(({ title, link }) => ({ title, link })) };
}

export async function webSearchFallback(env: Env, query: string) {
  const serper = await webSearchSerper(env, query);
  if (serper) return serper;
  const tavily = await webSearchTavily(env, query);
  if (tavily) return tavily;
  return null;
}

export async function synthesize(
  env: Env,
  query: string,
  contextBlocks: Array<{ id: string; title?: string; source?: string; content: string }>,
  webContext?: { context: string; sources: Array<{ title: string; link: string }>; },
  memorySummary?: string,
  reasoningEffort: "low" | "medium" | "high" = "medium"
): Promise<{ answer: string; reasoning_summary?: string; usage?: any }> {
  const contextText = contextBlocks
    .map((b, i) => `[#${i + 1} ${b.title ?? b.id}${b.source ? ` | ${b.source}` : ""}]\n${b.content}`)
    .join("\n\n");

  const webText = webContext?.context ? `\n\nWeb results:\n${webContext.context}` : "";
  const memoryText = memorySummary && memorySummary.trim() ? `\n\nConversation memory (for context, do not cite):\n${memorySummary.trim()}` : "";

  const systemPrompt = `You are an expert Bluetooth assistant. Answer using ONLY the provided document context. Prefer concise bullet points. After each factual sentence, include a citation [#n]/[Wn]. Quote exact technical names or identifiers verbatim with a citation. Do NOT add facts that are not present. When multiple sources appear, keep claims attributable to each source separate. If the context is insufficient for part of the question, explicitly state what is missing rather than guessing.`;
  const userPrompt = `Question: ${query}\n\nContext:\n${contextText}${webText}${memoryText}`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  // Also prepare a plain input string for models that expect { input } instead of chat { messages }
  const inputText = `${systemPrompt}\n\n${userPrompt}`;

  // Helper to normalize various Workers AI response shapes into plain text
  const extractText = (res: any): string | null => {
    if (!res) return null;
    const tryGet = (
      // ordered list of accessors
      getters: Array<() => unknown>
    ): string | null => {
      for (const g of getters) {
        try {
          const v = g();
          if (typeof v === "string" && v.trim()) return v;
          if (Array.isArray(v) && typeof v[0] === "string" && v[0].trim()) return v[0];
          // Some models return [{ content: [{ text: "..." }] }]
          if (Array.isArray(v) && v[0]?.content && Array.isArray(v[0].content) && typeof v[0].content[0]?.text === "string") {
            const t = v[0].content[0].text;
            if (t.trim()) return t;
          }
        } catch { /* ignore */ }
      }
      return null;
    };

    // Handle Responses API shape: top-level { object: "response", output: [...] }
    try {
      const out = res.output;
      if (Array.isArray(out) && out.length > 0) {
        // Prefer the last message-like block
        for (let i = out.length - 1; i >= 0; i--) {
          const block = out[i];
          const contentArr = block?.content;
          if (Array.isArray(contentArr)) {
            // Find first item with string text
            for (const it of contentArr) {
              const txt = it?.text;
              if (typeof txt === "string" && txt.trim()) return txt;
            }
          }
        }
      }
    } catch { /* ignore */ }

    return (
      tryGet([
        () => res.choices?.[0]?.message?.content,
        () => res.result?.choices?.[0]?.message?.content,
        () => res.output_text,
        () => res.result?.output_text,
        () => res.content,
        () => res.result?.content,
        () => res.response,
        () => res.result?.response,
        () => res.text,
        () => res.result?.text,
        () => res.outputs,            // e.g., [{ content: [{ text }]}]
        () => res.result?.output,     // e.g., [{ content: [{ text }]}]
      ])
    );
  };

  // Enhanced generation with reasoning for GPT OSS 120B
  const generationInput = {
    input: messages,
    reasoning: {
      effort: reasoningEffort,
      summary: env.REASONING_SUMMARY_LEVEL || "detailed"
    },
    temperature: 0.2,
    max_tokens: 800
  };

  try {
    // Try with reasoning parameters first (GPT OSS 120B)
    const res: any = await env.AI.run(env.MODEL_GENERATION, generationInput);
    const content = extractText(res);
    
    if (typeof content === "string" && content.trim().length > 0) {
      return {
        answer: content,
        reasoning_summary: res?.reasoning_summary || res?.result?.reasoning_summary,
        usage: res?.usage || res?.result?.usage
      };
    }
  } catch (error) {
    console.log("Reasoning generation failed, falling back to basic generation:", error);
    // fall through to basic generation
  }

  try {
    // Fallback: basic chat-style without reasoning
    const res: any = await env.AI.run(env.MODEL_GENERATION, { messages, temperature: 0.2, max_tokens: 800 });
    const content = extractText(res);
    if (typeof content === "string" && content.trim().length > 0) {
      return {
        answer: content,
        usage: res?.usage || res?.result?.usage
      };
    }
  } catch (_) {
    // fall through to input-style
  }

  // Fallback: input-style schema
  const res2: any = await env.AI.run(env.MODEL_GENERATION, { input: inputText, temperature: 0.2, max_tokens: 800 });
  const content2 = extractText(res2);
  if (typeof content2 === "string" && content2.trim()) {
    return {
      answer: content2,
      usage: res2?.usage || res2?.result?.usage
    };
  }
  
  // As last resort, return debug info
  return {
    answer: JSON.stringify(res2 ?? {}, null, 2),
    usage: res2?.usage || res2?.result?.usage
  };
}

export async function expandQueries(env: Env, query: string, maxVariants: number = 2): Promise<string[]> {
  if (maxVariants <= 0) return [];
  const prompt = `Generate ${maxVariants} short alternative phrasings for the following Bluetooth technical question. One per line, no numbering, no punctuation beyond what's necessary. Keep jargon terms.
Question: ${query}`;
  const tryExtract = (res: any): string[] => {
    const text = (
      res?.choices?.[0]?.message?.content ||
      res?.output_text ||
      res?.content ||
      res?.result?.output_text ||
      res?.result?.text ||
      (Array.isArray(res?.output) && res.output[res.output.length - 1]?.content?.[0]?.text) ||
      res?.text ||
      ""
    );
    const s = String(text || "");
    const lines = s.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const out: string[] = [];
    for (const l of lines) {
      const li = l.replace(/^[-*\d.\)\]]+\s*/, "").trim();
      if (li && !out.includes(li)) out.push(li);
      if (out.length >= maxVariants) break;
    }
    return out;
  };

  // Try chat then input style
  try {
    const res: any = await env.AI.run(env.MODEL_GENERATION, { messages: [
      { role: "system", content: "You rewrite queries precisely without changing intent." },
      { role: "user", content: prompt }
    ], temperature: 0.2, max_tokens: 200 });
    const v = tryExtract(res);
    if (v.length) return v;
  } catch {}
  try {
    const res2: any = await env.AI.run(env.MODEL_GENERATION, { input: prompt, temperature: 0.2, max_tokens: 200 });
    const v2 = tryExtract(res2);
    if (v2.length) return v2;
  } catch {}
  return [];
}

export async function vectorizeUpsert(env: Env, vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>): Promise<void> {
  if (!vectors.length) return;
  if (env.VECTORIZE_INDEX && typeof (env.VECTORIZE_INDEX as any).upsert === "function") {
    await env.VECTORIZE_INDEX.upsert(vectors);
    return;
  }
  // Local dev fallback
  for (const v of vectors) devVectorStore.push({ id: v.id, values: v.values, metadata: v.metadata });
}

export async function vectorizeQuery(env: Env, vector: number[], topK: number): Promise<RetrievedChunk[]> {
  // Guard against empty/invalid vectors; degrade gracefully
  if (!Array.isArray(vector) || vector.length === 0 || !vector.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return [];
  }

  if (env.VECTORIZE_INDEX && typeof (env.VECTORIZE_INDEX as any).query === "function") {
    const fvec = new Float32Array(vector);
    try {
      // Try object-form first (v2)
      const result = await (env.VECTORIZE_INDEX as any).query({ vector: fvec, topK, returnMetadata: true });
      const matches = result?.matches ?? [];
      return matches.map((m: any) => ({
        id: m.id,
        score: m.score,
        content: String(m.metadata?.content ?? ""),
        metadata: (m.metadata ?? {}) as RetrievedChunk["metadata"],
      }));
    } catch (_err1) {
      try {
        // Fallback to positional-form (older bindings): query(vector, options)
        const result2 = await (env.VECTORIZE_INDEX as any).query(fvec, { topK, returnMetadata: true });
        const matches2 = result2?.matches ?? [];
        return matches2.map((m: any) => ({
          id: m.id,
          score: m.score,
          content: String(m.metadata?.content ?? ""),
          metadata: (m.metadata ?? {}) as RetrievedChunk["metadata"],
        }));
      } catch (_err2) {
        return [];
      }
    }
  }
  // Local dev fallback
  const scored = devVectorStore.map((p) => ({ p, score: cosineSimilarity(vector, p.values) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map(({ p, score }) => ({
    id: p.id,
    score,
    content: String((p.metadata as any)?.content ?? ""),
    metadata: (p.metadata ?? {}) as RetrievedChunk["metadata"],
  }));
}

// Enhanced semantic search with BGE-M3 query-context scoring
export async function enhancedSemanticSearch(env: Env, query: string, topK: number = 20, useReranking: boolean = true): Promise<RetrievedChunk[]> {
  try {
    // 1. Generate query embedding with BGE-M3 query prefix
    const queryVector = await embedText(env, query, true);
    
    // 2. Initial vector search
    const initialResults = await vectorizeQuery(env, queryVector, Math.min(topK * 2, 50));
    
    if (initialResults.length === 0) {
      return [];
    }

    // 3. Enhanced scoring with BGE-M3 multi-granularity approach
    const enhancedResults = initialResults.map(chunk => {
      // Re-calculate score using BGE-M3 enhanced scoring
      const enhancedScore = calculateBgeM3Score(
        queryVector,
        // We don't have the chunk's vector, so we use the original similarity score as a proxy
        // In a full implementation, we'd store chunk vectors or re-embed them
        [chunk.score], // Simplified - in practice you'd want the actual embedding
        query,
        chunk.content
      );
      
      return {
        ...chunk,
        score: enhancedScore
      };
    });

    // 4. Sort by enhanced scores
    enhancedResults.sort((a, b) => b.score - a.score);

    // 5. Optional reranking with BGE reranker
    if (useReranking && enhancedResults.length > 1) {
      try {
        const passages = enhancedResults.map(r => r.content);
        const reranked = await rerank(env, query, passages);
        
        if (reranked.length > 0) {
          // Apply reranking scores
          const rerankedResults = reranked
            .filter(r => r.index < enhancedResults.length)
            .map(r => ({
              ...enhancedResults[r.index],
              score: r.score
            }))
            .sort((a, b) => b.score - a.score);
          
          return rerankedResults.slice(0, topK);
        }
      } catch (rerankError) {
        console.log("Reranking failed, using enhanced scores:", rerankError);
        // Fall through to enhanced results
      }
    }

    return enhancedResults.slice(0, topK);
    
  } catch (error) {
    console.error("Enhanced semantic search failed:", error);
    // Fallback to basic search
    const queryVector = await embedText(env, query, false);
    return await vectorizeQuery(env, queryVector, topK);
  }
}