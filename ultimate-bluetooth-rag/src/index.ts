import { chunkText } from "./chunker";
import type { Env, IngestRequestBody, QueryRequestBody, RetrievedChunk, ChatRequestBody, ChatResponse, Citation, ChatMessage, BluetoothToolRequest, BluetoothToolResponse } from "./types";
import { embedText, rerank, synthesize, vectorizeQuery, vectorizeUpsert, numericEnv, expandQueries } from "./retrieval";
import { AgentOrchestrator } from "./crew_agents";
import { appendMessage, ensureConversation, exportConversation, getConversation, updateSummaryIfNeeded, clearConversation, saveConversation } from "./memory";

function cleanText(text: string): string {
  if (!text) return text;
  
  // Fix common UTF-8 encoding issues where special chars got corrupted
  return text
    // Fix bullet points and dashes
    .replace(/â¢/g, '•')           // bullet point
    .replace(/â€¢/g, '•')         // bullet point variant
    .replace(/â€"/g, '—')         // em dash
    .replace(/â€"/g, '–')         // en dash
    .replace(/â€™/g, "'")         // right single quotation mark
    .replace(/â€œ/g, '"')         // left double quotation mark
    .replace(/â€?/g, '"')         // right double quotation mark
    .replace(/â€¦/g, '…')         // horizontal ellipsis
    
    // Fix common letter combinations
    .replace(/Ã¡/g, 'á')          // a with acute
    .replace(/Ã©/g, 'é')          // e with acute
    .replace(/Ã­/g, 'í')          // i with acute
    .replace(/Ã³/g, 'ó')          // o with acute
    .replace(/Ãº/g, 'ú')          // u with acute
    .replace(/Ã±/g, 'ñ')          // n with tilde
    .replace(/Ã /g, 'à')          // a with grave
    .replace(/Ã¢/g, 'â')          // a with circumflex
    .replace(/Ã§/g, 'ç')          // c with cedilla
    
    // Fix other common corruptions
    .replace(/â/g, '-')           // various dash variants
    .replace(/â¯/g, ' ')          // narrow no-break space
    .replace(/Â /g, ' ')          // non-breaking space
    .replace(/â\s/g, '• ')        // bullet with space
    
    // Clean up multiple spaces and normalize whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

function jsonResponse(obj: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(obj, null, 2), { headers: { "content-type": "application/json; charset=utf-8" }, ...init });
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

// Basic anonymous identity cookie for associating conversations with a user
function getOrSetUserIdCookie(request: Request): { userId: string; setCookieHeader?: string } {
  const cookies = request.headers.get("cookie") || request.headers.get("Cookie") || "";
  const m = /(?:^|;\s*)bt_user_id=([^;]+)/i.exec(cookies);
  if (m && m[1]) {
    return { userId: decodeURIComponent(m[1]) };
  }
  const userId = `u_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
  const setCookieHeader = `bt_user_id=${encodeURIComponent(userId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`;
  return { userId, setCookieHeader };
}

// --- Streaming helpers (SSE and plain text) ---
const textEncoder = new TextEncoder();

function sseHeaders(): HeadersInit {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-no-compression": "1",
  };
}

function encodeSSEData(data: string): Uint8Array {
  // Prefix each line with 'data: ' to respect SSE framing
  const payload = data.replace(/\r?\n/g, "\ndata: ");
  return textEncoder.encode(`data: ${payload}\n\n`);
}

function encodeSSEEvent(event: string, data: string): Uint8Array {
  const framed = `event: ${event}\n` + `data: ${data.replace(/\r?\n/g, "\ndata: ")}\n\n`;
  return textEncoder.encode(framed);
}

/**
 * Creates a Response that streams Server-Sent Events. Returns helpers to send data/events and to close the stream.
 */
function createSSEStream(): { response: Response; send: (data: string) => void; sendEvent: (event: string, data: string) => void; close: () => void } {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      // Send an initial comment to establish the stream in some clients
      controller.enqueue(textEncoder.encode(": connected\n\n"));
    },
    cancel() {
      controllerRef = null;
    },
  });
  const send = (data: string) => {
    if (!controllerRef) return;
    controllerRef.enqueue(encodeSSEData(data));
  };
  const sendEvent = (event: string, data: string) => {
    if (!controllerRef) return;
    controllerRef.enqueue(encodeSSEEvent(event, data));
  };
  const close = () => {
    try { controllerRef?.close(); } catch {}
    controllerRef = null;
  };
  const response = new Response(stream, { headers: sseHeaders() });
  return { response, send, sendEvent, close };
}

/**
 * Creates a plain text streaming Response (non-SSE). Useful for chunked text where SSE is not desired.
 */
function createTextStream(): { response: Response; sendText: (chunk: string) => void; close: () => void } {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controllerRef = controller; },
    cancel() { controllerRef = null; }
  });
  const sendText = (chunk: string) => {
    if (!controllerRef) return;
    controllerRef.enqueue(textEncoder.encode(chunk));
  };
  const close = () => { try { controllerRef?.close(); } catch {} controllerRef = null; };
  const response = new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" } });
  return { response, sendText, close };
}

/**
 * Helper to choose between streaming (SSE) and JSON fallback.
 */
async function respondStreamOrJson(
  stream: boolean | undefined,
  buildStream: () => { response: Response },
  buildJson: () => Promise<Response>
): Promise<Response> {
  if (stream) return buildStream().response;
  return await buildJson();
}

async function handleHealth(): Promise<Response> {
  return jsonResponse({ ok: true, message: "bt-rag healthy" });
}

async function handleIngest(request: Request, env: Env): Promise<Response> {
  if (!requireAuth(request, env.API_AUTH_TOKEN)) return unauthorized();
  const body = (await request.json()) as IngestRequestBody;
  if (!body?.id || !body?.text) return jsonResponse({ error: "Expected { id, text }" }, { status: 400 });

  const { id, text, title, source } = body;

  // Clean text before chunking to prevent encoding issues
  const cleanedText = cleanText(text);
  
  // Chunk
  const chunks = chunkText(cleanedText);
  try { console.log("INGEST", JSON.stringify({ id, title, source, chunks: chunks.length })); } catch {}

  // Embed + upsert sequentially (safer on free tier)
  const vectors: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }> = [];
  let index = 0;
  for (const c of chunks) {
    // Clean chunk content as well
    const cleanedContent = cleanText(c.content);
    const emb = await embedText(env, cleanedContent);
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
        content: cleanedContent,
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

function newConversationId(): string {
  const date = new Date();
  const iso = date.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `c_${iso}_${rand}`;
}

function getLastUserMessage(messages: ChatMessage[] = []): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user" && typeof messages[i]?.content === "string") return messages[i];
  }
  return null;
}


// --- CrewAI Multi-Agentic Chat Handler ---
async function handleChat(request: Request, env: Env): Promise<Response> {
  if (!requireAuth(request, env.API_AUTH_TOKEN)) return unauthorized();
  const body = (await request.json().catch(() => ({}))) as ChatRequestBody;
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (messages.length === 0) return jsonResponse({ error: "Expected { messages }" }, { status: 400 });

  const lastUser = getLastUserMessage(messages);
  if (!lastUser) return jsonResponse({ error: "Expected at least one user message" }, { status: 400 });

  const conversationId = body.conversationId && String(body.conversationId).trim() ? String(body.conversationId).trim() : newConversationId();
  const stream = body.stream !== false; // default true
  const maxIter = typeof body.maxIter === 'number' && body.maxIter > 0 ? Math.min(body.maxIter, 10) : 2;

  // Memory: ensure conversation and append the latest user message, associate with anonymous userId
  const { userId, setCookieHeader } = getOrSetUserIdCookie(request);
  await ensureConversation(env, conversationId, userId);
  await appendMessage(env, conversationId, { role: "user", content: lastUser.content });
  await updateSummaryIfNeeded(env, conversationId);

  // --- CrewAI Orchestrator ---
  const orchestrator = new AgentOrchestrator();
  const t0 = Date.now();
  let chatResponse: ChatResponse;
  try {
    chatResponse = await orchestrator.processQuery(env, conversationId, String(lastUser.content || "").trim(), undefined, undefined, maxIter);
  } catch (err: any) {
    console.log("[Orchestrator] ERROR", err);
    return jsonResponse({ error: String(err?.message ?? err) }, { status: 500 });
  }
  const ms = Date.now() - t0;
  try { console.log("CREWAI_CHAT_ANSWER", JSON.stringify({ conversationId, ms, chars: chatResponse.answer.length, citations: chatResponse.citations.length })); } catch {}

  // Debug: Check what's in the citations from crew agents
  console.log("CREW CITATIONS DEBUG:", JSON.stringify(chatResponse.citations.slice(0, 3), null, 2));

  // Clean the answer text before persisting and returning
  const cleanedAnswer = cleanText(chatResponse.answer);
  chatResponse.answer = cleanedAnswer;

  // Persist assistant message and citations
  await appendMessage(env, conversationId, { role: "assistant", content: cleanedAnswer });
  try {
    const convAfter = await getConversation(env, conversationId);
    if (convAfter) {
      convAfter.lastCitations = chatResponse.citations;
      await saveConversation(env, convAfter);
    }
  } catch {}
  const base = jsonResponse(chatResponse);
  if (setCookieHeader) base.headers.set("set-cookie", setCookieHeader);
  return base;
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

  const synthesisResult = await synthesize(env, query, contextBlocks);
  const ms = Date.now() - t0;
  try { console.log("RAG_ANSWER", JSON.stringify({ ms, chars: synthesisResult.answer.length, citations: contextBlocks.length, reasoning: !!synthesisResult.reasoning_summary })); } catch {}

  return jsonResponse({
    ok: true,
    query,
    topScore,
    citations: contextBlocks.map((c, i) => {
      console.log(`Citation ${i + 1} structure:`, JSON.stringify({ id: c.id, hasContent: !!c.content, contentLength: c.content?.length, title: c.title, source: c.source }, null, 2));
      return { 
        ref: `#${i + 1}`, 
        id: c.id, 
        title: c.title ? cleanText(c.title) : c.id, 
        source: c.source ? cleanText(c.source) : 'Unknown',
        content: c.content ? cleanText(c.content) : 'Content not available' // Clean content for modal display
      }
    }),
    answer: cleanText(synthesisResult.answer),
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

async function handleMemoryExport(request: Request, env: Env, conversationId: string): Promise<Response> {
  if (!requireAuth(request, env.API_AUTH_TOKEN)) return unauthorized();
  const conv = await exportConversation(env, conversationId);
  if (!conv) return jsonResponse({ error: "Not found" }, { status: 404 });
  return jsonResponse({ ok: true, conversation: conv });
}

async function handleMemoryClear(request: Request, env: Env, conversationId: string): Promise<Response> {
  if (!requireAuth(request, env.API_AUTH_TOKEN)) return unauthorized();
  const ok = await clearConversation(env, conversationId);
  return jsonResponse({ ok });
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
      if (url.pathname === "/chat" && request.method === "POST") return handleChat(request, env);
      if (url.pathname === "/query" && request.method === "POST") return handleQuery(request, env);
      if (url.pathname === "/bluetooth/tool" && request.method === "POST") {
        // Placeholder handler: no real device I/O in Workers; returns not-implemented
        if (!requireAuth(request, env.API_AUTH_TOKEN)) return unauthorized();
        const body = (await request.json().catch(() => ({}))) as BluetoothToolRequest;
        const resp: BluetoothToolResponse = { ok: false, message: `Tool action '${String(body?.action || "").toLowerCase()}' is not supported in Workers runtime`, data: body };
        return jsonResponse(resp, { status: 400 });
      }
      if (url.pathname.startsWith("/memory/") && request.method === "GET") {
        const id = url.pathname.split("/")[2] || "";
        if (!id) return jsonResponse({ error: "Missing conversationId" }, { status: 400 });
        return handleMemoryExport(request, env, id);
      }
      if (url.pathname.startsWith("/memory/") && request.method === "DELETE") {
        const id = url.pathname.split("/")[2] || "";
        if (!id) return jsonResponse({ error: "Missing conversationId" }, { status: 400 });
        return handleMemoryClear(request, env, id);
      }
      if (url.pathname === "/debug/diag" && request.method === "POST") return handleDiag(request, env);
      return jsonResponse({ error: "Not found" }, { status: 404 });
    } catch (err: any) {
      return jsonResponse({ error: String(err?.message ?? err) }, { status: 500 });
    }
  }
}; 