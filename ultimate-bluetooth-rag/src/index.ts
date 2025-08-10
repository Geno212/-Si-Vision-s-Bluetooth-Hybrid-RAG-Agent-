import { chunkText } from "./chunker";
import type { Env, IngestRequestBody, QueryRequestBody, RetrievedChunk } from "./types";
import { embedText, rerank, synthesize, vectorizeQuery, vectorizeUpsert, numericEnv, expandQueries } from "./retrieval";

function jsonResponse(obj: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(obj, null, 2), { headers: { "content-type": "application/json" }, ...init });
}

function htmlResponse(text: string, init: ResponseInit = {}): Response {
  return new Response(text, { headers: { "content-type": "text/html; charset=utf-8" }, ...init });
}

function unauthorized(): Response {
  return jsonResponse({ error: "Unauthorized" }, { status: 401 });
}

function requireAuth(request: Request, token?: string): boolean {
  if (!token) return true; // if no token set, allow (dev convenience)
  const auth = request.headers.get("authorization") || request.headers.get("Authorization");
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) return false;
  const provided = auth.slice("bearer ".length);
  return provided === token;
}

async function handleHealth(): Promise<Response> {
  return jsonResponse({ ok: true, message: "bt-rag healthy" });
}

async function handleIngest(request: Request, env: Env): Promise<Response> {
  if (!requireAuth(request, env.API_AUTH_TOKEN)) return unauthorized();
  const body = (await request.json()) as IngestRequestBody;
  if (!body?.id || !body?.text) return jsonResponse({ error: "Expected { id, text }" }, { status: 400 });

  const { id, text, title, source } = body;

  // Chunk
  const chunks = chunkText(text);
  try { console.log("INGEST", JSON.stringify({ id, title, source, chunks: chunks.length })); } catch {}

  // Embed + upsert sequentially (safer on free tier)
  const vectors: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }> = [];
  let index = 0;
  for (const c of chunks) {
    const emb = await embedText(env, c.content);
    const vecId = `${id}::${index}`;
    vectors.push({
      id: vecId,
      values: emb,
      metadata: {
        doc_id: id,
        title,
        source,
        chunk_index: index,
        offset: c.offset,
        length: c.length,
        content: c.content,
      },
    });
    index += 1;
  }

  await vectorizeUpsert(env, vectors);
  try { console.log("UPSERT", JSON.stringify({ id, points: vectors.length, dim: vectors[0]?.values?.length ?? 0 })); } catch {}

  // Store raw text in R2 (optional but useful)
  try {
    await env.DOCS_BUCKET.put(`docs/${id}.txt`, text, { httpMetadata: { contentType: "text/plain;charset=utf-8" } });
  } catch (err) {
    // non-fatal
  }

  return jsonResponse({ ok: true, id, chunks: chunks.length, upserted: vectors.length });
}

async function pickContext(env: Env, query: string, candidates: RetrievedChunk[], topRerank: number): Promise<Array<{ id: string; title?: string; source?: string; content: string }>> {
  if (!candidates.length) return [];
  const passages = candidates.map(c => c.content);
  const reranked = await rerank(env, query, passages);
  // Per-document cap to ensure diversity
  const PER_DOC_CAP = 2;
  const MIN_DISTINCT_DOCS = 2;
  const docCounts: Record<string, number> = {};
  const selected: RetrievedChunk[] = [];
  const sorted = reranked
    .map(r => ({ r, c: candidates[r.index] }))
    .filter(x => x.c)
    .sort((a, b) => (b.r.score - a.r.score));
  for (const x of sorted) {
    const docId = String((x.c.metadata as any)?.doc_id ?? "");
    const count = docCounts[docId] || 0;
    if (docId && count >= PER_DOC_CAP) continue;
    selected.push(x.c);
    if (docId) docCounts[docId] = count + 1;
    if (selected.length >= topRerank) break;
  }
  // Ensure minimum number of distinct sources when available
  const haveDistinct = new Set(selected.map(s => String((s.metadata as any)?.doc_id ?? "")));
  if (haveDistinct.size < MIN_DISTINCT_DOCS) {
    for (const x of sorted) {
      if (selected.includes(x.c)) continue;
      const docId = String((x.c.metadata as any)?.doc_id ?? "");
      if (!docId || haveDistinct.has(docId)) continue;
      if (selected.length < topRerank) {
        selected.push(x.c);
        haveDistinct.add(docId);
      }
      if (haveDistinct.size >= MIN_DISTINCT_DOCS) break;
    }
  }
  return selected.map((c) => ({ id: c.id, title: String(c.metadata?.title ?? ""), source: String(c.metadata?.source ?? ""), content: c.content }));
}

async function handleQuery(request: Request, env: Env): Promise<Response> {
  if (!requireAuth(request, env.API_AUTH_TOKEN)) return unauthorized();
  const body = (await request.json()) as QueryRequestBody;
  const query = body?.query?.trim();
  if (!query) return jsonResponse({ error: "Expected { query }" }, { status: 400 });

  const topK = numericEnv(String(body.topK ?? env.TOP_K), 20);
  const topRerank = numericEnv(String(body.topRerank ?? env.TOP_RERANK), 5);

  const t0 = Date.now();
  try { console.log("RAG_QUERY_START", JSON.stringify({ query: query.slice(0, 160), topK, topRerank })); } catch {}

  // Embed the query. If we cannot, return model output with no context (prompt will state insufficiency).
  let qvec: number[] | null = null;
  try {
    qvec = await embedText(env, query);
  } catch (_) {
    qvec = null;
  }
  try { console.log("RAG_EMBED", JSON.stringify({ length: Array.isArray(qvec) ? qvec.length : 0 })); } catch {}

  let contextBlocks: Array<{ id: string; title?: string; source?: string; content: string }> = [];
  let topScore = 0;

  if (Array.isArray(qvec) && qvec.length > 0) {
    // Multi-vector retrieval with RRF fusion
    const variants = await expandQueries(env, query, 2);
    const variantTexts = [query, ...variants];
    // Embed in parallel
    const vectors = await Promise.all(
      variantTexts.map((t) => embedText(env, t).catch(() => [] as number[]))
    );

    // Query Vectorize in parallel
    const perQueryResults = await Promise.all(
      vectors
        .filter((v) => Array.isArray(v) && v.length > 0)
        .map((v) => vectorizeQuery(env, v as number[], topK))
    );

    // Reciprocal Rank Fusion (RRF)
    const K = 60;
    const fused: Record<string, { item: RetrievedChunk; score: number }> = {};
    perQueryResults.forEach((list, qi) => {
      list.forEach((m, idx) => {
        const rrf = 1 / (K + idx + 1);
        const existing = fused[m.id];
        if (!existing || rrf + (existing?.score ?? 0) > existing.score) {
          fused[m.id] = { item: m, score: (existing?.score ?? 0) + rrf };
        } else {
          fused[m.id].score += rrf;
        }
      });
    });

    const candidates = Object.values(fused)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((x) => x.item);
    topScore = candidates[0]?.score ?? 0;
    if (candidates.length > 0) {
      contextBlocks = await pickContext(env, query, candidates, topRerank);
    }
    try {
      console.log(
        "RAG_VECTORIZE",
        JSON.stringify({
          candidates: candidates.length,
          variants: variants.length,
          topScore,
          kept: contextBlocks.length,
          keepIds: contextBlocks.map(c => c.id).slice(0, 10),
          perDoc: candidates.reduce((acc: any, m) => { const d = String((m.metadata as any)?.doc_id ?? ""); acc[d] = (acc[d]||0)+1; return acc; }, {}),
          distinctKeptDocs: Array.from(new Set(contextBlocks.map(cb => String((candidates.find(x=>x.id===cb.id)?.metadata as any)?.doc_id ?? "")))).length
        })
      );
    } catch {}
  }

  const answer = await synthesize(env, query, contextBlocks);
  const ms = Date.now() - t0;
  try { console.log("RAG_ANSWER", JSON.stringify({ ms, chars: answer.length, citations: contextBlocks.length })); } catch {}

  return jsonResponse({
    ok: true,
    query,
    topScore,
    citations: contextBlocks.map((c, i) => ({ ref: `#${i + 1}`, id: c.id, title: c.title, source: c.source })),
    answer,
  });
}

async function handleDiag(request: Request, env: Env): Promise<Response> {
  if (!requireAuth(request, env.API_AUTH_TOKEN)) return unauthorized();
  const body = (await request.json().catch(() => ({}))) as { query?: string; topK?: number };
  const query = String(body?.query ?? "").trim();
  if (!query) return jsonResponse({ error: "Expected { query }" }, { status: 400 });

  const topK = numericEnv(String(body.topK ?? env.TOP_K), 5);
  const diag: any = { model_embedding: env.MODEL_EMBEDDING };

  let embedding: number[] | null = null;
  try {
    embedding = await embedText(env, query);
    diag.embedding = {
      length: embedding.length,
      sample: embedding.slice(0, 5),
      allFinite: embedding.every((n) => Number.isFinite(n)),
    };
  } catch (err: any) {
    diag.embedding_error = String(err?.message ?? err);
  }

  let matches: Array<{ id: string; score: number; title?: string; source?: string; contentSnippet?: string }> = [];
  let vectorizeError: string | undefined;
  if (Array.isArray(embedding) && embedding.length > 0) {
    try {
      const fvec = new Float32Array(embedding);
      // Try object-form first
      try {
        const result: any = await (env.VECTORIZE_INDEX as any).query({ vector: fvec, topK, returnMetadata: true });
        const raw = Array.isArray(result?.matches) ? result.matches : [];
        matches = raw.map((m: any) => ({
          id: String(m.id),
          score: Number(m.score ?? 0),
          title: String(m.metadata?.title ?? ""),
          source: String(m.metadata?.source ?? ""),
          contentSnippet: String(m.metadata?.content ?? "").slice(0, 160),
        }));
      } catch (err1: any) {
        diag.objectFormError = String(err1?.message ?? err1);
        // Fallback to positional-form (legacy bindings)
        const result2: any = await (env.VECTORIZE_INDEX as any).query(fvec, { topK, returnMetadata: true });
        const raw2 = Array.isArray(result2?.matches) ? result2.matches : [];
        matches = raw2.map((m: any) => ({
          id: String(m.id),
          score: Number(m.score ?? 0),
          title: String(m.metadata?.title ?? ""),
          source: String(m.metadata?.source ?? ""),
          contentSnippet: String(m.metadata?.content ?? "").slice(0, 160),
        }));
      }
    } catch (err: any) {
      vectorizeError = String(err?.message ?? err);
    }
  }

  return jsonResponse({ ok: true, query, diag, vectorizeError, matches });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);

      // Serve UI
      if (url.pathname === "/" || url.pathname.startsWith("/assets")) {
        // When [assets] is configured, the default asset handler is available at env.ASSETS.
        // Type casting avoids adding a custom type.
        const assets = (env as any).ASSETS;
        if (assets?.fetch) {
          return assets.fetch(request);
        }
      }

      if (url.pathname === "/health") return handleHealth();
      if (url.pathname === "/ingest" && request.method === "POST") return handleIngest(request, env);
      if (url.pathname === "/query" && request.method === "POST") return handleQuery(request, env);
      if (url.pathname === "/debug/diag" && request.method === "POST") return handleDiag(request, env);
      return jsonResponse({ error: "Not found" }, { status: 404 });
    } catch (err: any) {
      return jsonResponse({ error: String(err?.message ?? err) }, { status: 500 });
    }
  }
}; 