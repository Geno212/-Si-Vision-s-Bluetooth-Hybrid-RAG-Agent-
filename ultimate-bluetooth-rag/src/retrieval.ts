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
  if (Array.isArray(result?.data) && typeof result.data[0] === "number") return result.data as number[];
  if (Array.isArray(result?.data) && Array.isArray(result.data[0])) return result.data[0] as number[];
  if (Array.isArray(result?.data) && result.data[0]?.embedding) return result.data[0].embedding as number[];
  if (Array.isArray(result?.embeddings)) return result.embeddings[0] as number[];
  if (Array.isArray(result?.output) && Array.isArray(result.output[0])) return result.output[0] as number[];
  return null;
}

export async function embedText(env: Env, text: string): Promise<number[]> {
  try {
    const res: any = await env.AI.run(env.MODEL_EMBEDDING, { text });
    // Normalize common Workers AI response shapes
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
      return vec;
    }

    // If shape/validation unknown, try REST fallback
    const viaRest = await cfAiEmbedViaRest(env, text);
    if (Array.isArray(viaRest) && viaRest.length > 0 && viaRest.every((n) => typeof n === "number" && Number.isFinite(n))) {
      return viaRest;
    }
    throw new Error("Embedding returned empty or invalid vector");
  } catch (e) {
    // If AI binding fails (e.g., auth), try REST fallback
    const viaRest = await cfAiEmbedViaRest(env, text);
    if (Array.isArray(viaRest) && viaRest.length > 0 && viaRest.every((n) => typeof n === "number" && Number.isFinite(n))) {
      return viaRest;
    }
    throw e;
  }
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

export async function synthesize(env: Env, query: string, contextBlocks: Array<{ id: string; title?: string; source?: string; content: string }>, webContext?: { context: string; sources: Array<{ title: string; link: string }>; }): Promise<string> {
  const contextText = contextBlocks
    .map((b, i) => `[#${i + 1} ${b.title ?? b.id}${b.source ? ` | ${b.source}` : ""}]\n${b.content}`)
    .join("\n\n");

  const webText = webContext?.context ? `\n\nWeb results:\n${webContext.context}` : "";

  const systemPrompt = `You are an expert Bluetooth assistant. Answer using ONLY the provided context. Prefer concise bullet points. After each factual sentence, include a citation [#n]/[Wn]. Quote exact technical names or identifiers verbatim with a citation. Do NOT add facts that are not present. When multiple sources appear, keep claims attributable to each source separate. If the context is insufficient for part of the question, explicitly state what is missing rather than guessing.`;
  const userPrompt = `Question: ${query}\n\nContext:\n${contextText}${webText}`;

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

  // Attempt chat-style first
  try {
    const res: any = await env.AI.run(env.MODEL_GENERATION, { messages, temperature: 0.2, max_tokens: 800 });
    const content = extractText(res);
    if (typeof content === "string" && content.trim().length > 0) return content;
  } catch (_) {
    // fall through to input-style
  }

  // Fallback: input-style schema
  const res2: any = await env.AI.run(env.MODEL_GENERATION, { input: inputText, temperature: 0.2, max_tokens: 800 });
  const content2 = extractText(res2);
  if (typeof content2 === "string" && content2.trim()) return content2;
  // As last resort, JSON-serialize for debugging instead of [object Object]
  return JSON.stringify(res2 ?? {}, null, 2);
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