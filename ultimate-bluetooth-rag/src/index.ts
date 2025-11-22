import { chunkText } from "./chunker";
import type { Env, IngestRequestBody, QueryRequestBody, RetrievedChunk, ChatRequestBody, ChatResponse, Citation, ChatMessage, BluetoothToolRequest, BluetoothToolResponse, CorrectionFeedbackRequest, ChatResponseMetadata } from "./types";
import { embedText, embedTextBatch, embedTextSingle, rerank, synthesize, vectorizeQuery, vectorizeUpsert, numericEnv, expandQueries } from "./retrieval";
import { AgentOrchestrator } from "./crew_agents";
import { appendMessage, ensureConversation, exportConversation, getConversation, updateSummaryIfNeeded, clearConversation, saveConversation } from "./memory";
import { handleListDocuments, handleDocumentStats, handleDeleteDocument, handleCleanupAll } from "./admin";
import { checkCorrectionCache, storeCorrectionInCache, getCorrectionById, deleteCorrectionById, getCorrectionStats } from "./corrections";

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

async function handleR2Upload(request: Request, env: Env): Promise<Response> {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;
    
    if (!file) {
      return jsonResponse({ error: "No file provided" }, { status: 400 });
    }

    // Generate unique filename
    const timestamp = Date.now();
    const filename = `uploads/${timestamp}-${file.name}`;
    
    // Upload to R2
    const arrayBuffer = await file.arrayBuffer();
    await env.DOCS_BUCKET.put(filename, arrayBuffer, {
      httpMetadata: {
        contentType: file.type || 'application/octet-stream',
      },
    });

    return jsonResponse({ 
      ok: true, 
      message: "File uploaded successfully",
      filename: filename,
      size: arrayBuffer.byteLength
    });
  } catch (err: any) {
    console.error("R2 upload error:", err);
    return jsonResponse({ error: String(err?.message ?? err) }, { status: 500 });
  }
}

async function handleR2Process(request: Request, env: Env): Promise<Response> {
  try {
    const { filename } = await request.json() as { filename: string };
    
    if (!filename) {
      return jsonResponse({ error: "No filename provided" }, { status: 400 });
    }

    // Get file from R2
    const object = await env.DOCS_BUCKET.get(filename);
    if (!object) {
      return jsonResponse({ error: "File not found in R2" }, { status: 404 });
    }

    const arrayBuffer = await object.arrayBuffer();
    const file = new File([arrayBuffer], filename.split('/').pop() || 'document');

    // Process the same way as handlePublicIngest but with better memory management
    const formData = new FormData();
    formData.append('file', file);

    // Create a new request with the file data
    const ingestRequest = new Request(request.url, {
      method: 'POST',
      body: formData
    });

    // Process in chunks to avoid memory issues
    return await processFileInChunks(ingestRequest, env, filename);
  } catch (err: any) {
    console.error("R2 process error:", err);
    return jsonResponse({ error: String(err?.message ?? err) }, { status: 500 });
  }
}

async function processFileInChunks(request: Request, env: Env, sourceFilename: string): Promise<Response> {
  console.log(`[R2_PROCESS] Starting R2 file processing: ${sourceFilename}`);
  
  // Add timeout wrapper to prevent hanging - increased for large documents
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Processing timeout after 15 minutes')), 15 * 60 * 1000);
  });
  
  const processingPromise = async (): Promise<Response> => {
    try {
      const formData = await request.formData();
      const file = formData.get('file') as File;
      
      if (!file) {
        return jsonResponse({ error: "No file provided" }, { status: 400 });
      }

      console.log(`[R2_PROCESS] Processing file from R2: ${sourceFilename}, size: ${file.size} bytes`);

      const arrayBuffer = await file.arrayBuffer();
      
      // Handle different file types properly
      let textContent: string;
      const fileExtension = sourceFilename.toLowerCase().split('.').pop();
      
      console.log(`[R2_PROCESS] File type detected: ${fileExtension}`);
      
      if (fileExtension === 'pdf') {
        // For PDFs, we need proper text extraction - for now, use a simplified approach
        // Note: In production, you'd want to use pdf-parse or similar library
        console.log(`[R2_PROCESS] WARNING: PDF text extraction is simplified - may not work properly`);
        console.log(`[R2_PROCESS] Consider uploading the PDF as text or using proper PDF parser`);
        const uint8Array = new Uint8Array(arrayBuffer);
        textContent = new TextDecoder('utf-8', { ignoreBOM: true }).decode(uint8Array);
        
        // Basic PDF text extraction attempt
        const textMatch = textContent.match(/stream[\s]*(.+?)[\s]*endstream/g);
        if (textMatch && textMatch.length > 0) {
          textContent = textMatch.map(match => match.replace(/stream|endstream/g, '')).join('\n');
        }
      } else {
        // For text files, documents, etc.
        const uint8Array = new Uint8Array(arrayBuffer);
        textContent = new TextDecoder('utf-8', { ignoreBOM: true }).decode(uint8Array);
      }

      const cleanedText = cleanText(textContent);
      console.log(`[R2_PROCESS] Text extracted, length: ${cleanedText.length} characters`);
      
      if (cleanedText.length < 50) {
        throw new Error(`Text extraction failed or document too short (${cleanedText.length} chars). Consider uploading as text file.`);
      }

      const chunks = chunkText(cleanedText, { maxChars: 1200, overlapChars: 200 }); // Use same settings as main ingestion
      console.log(`[R2_PROCESS] Created ${chunks.length} chunks`);

      let successCount = 0;
      let errorCount = 0;
      const batchSize = 25; // Larger batches for faster processing
      
      console.log(`[R2_PROCESS] Using batch size: ${batchSize} (optimized for BGE-Large model)`);

      // Process chunks in batches using improved system
      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const batchNumber = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(chunks.length / batchSize);
        
        console.log(`[R2_PROCESS] Processing batch ${batchNumber}/${totalBatches} (chunks ${i + 1}-${Math.min(i + batchSize, chunks.length)}/${chunks.length})`);
        
        try {
          // Extract text content for embedding
          const texts = batch.map(chunk => chunk.content);
          
          console.log(`[R2_PROCESS] Batch ${batchNumber} text lengths: [${texts.map(t => t.length).join(', ')}]`);
          
          // Use improved batch embedding with enhanced logging
          const startTime = Date.now();
          const embeddings = await embedTextBatch(env, texts);
          const embeddingTime = Date.now() - startTime;
          
          console.log(`[R2_PROCESS] Batch ${batchNumber} embedding completed in ${embeddingTime}ms`);
          
          if (embeddings.length !== texts.length) {
            console.warn(`[R2_PROCESS] Embedding count mismatch: ${embeddings.length} vs ${texts.length}`);
          }

          // Prepare vectors for upsert
          const vectors = batch.map((chunk, idx) => ({
            id: `${file.name}-chunk-${i + idx}`,
            values: embeddings[idx] || new Array(1024).fill(0), // BGE-Large produces 1024-dim vectors
            metadata: {
              title: file.name,
              source: sourceFilename,
              content: chunk.content,
              chunk_index: i + idx,
              total_chunks: chunks.length,
            }
          }));

          // Upsert to vector database
          console.log(`[R2_PROCESS] Upserting batch ${batchNumber} with ${vectors.length} vectors...`);
          await vectorizeUpsert(env, vectors);
          successCount += batch.length;
          console.log(`[R2_PROCESS] Batch ${batchNumber} completed successfully. Total success: ${successCount}/${chunks.length}`);

          // Shorter delay since BGE-Large calls are already slow
          if (i + batchSize < chunks.length) {
            console.log(`[R2_PROCESS] Pausing 5 seconds before next batch...`);
            await new Promise(resolve => setTimeout(resolve, 5000)); // 5 seconds delay
          }
          
        } catch (batchError: any) {
          console.error(`[R2_PROCESS] Batch ${batchNumber} failed:`, batchError.message);
          console.error(`[R2_PROCESS] Error details:`, batchError.stack || batchError);
          errorCount += batch.length;
          
          // Try individual processing for failed batch
          console.log(`[R2_PROCESS] Attempting individual processing for failed batch ${batchNumber}...`);
          for (let j = 0; j < batch.length; j++) {
            try {
              console.log(`[R2_PROCESS] Individual processing chunk ${i + j + 1}/${chunks.length}`);
              const embedding = await embedTextSingle(env, batch[j].content);
              const vector = {
                id: `${file.name}-chunk-${i + j}`,
                values: embedding || new Array(1024).fill(0),
                metadata: {
                  title: file.name,
                  source: sourceFilename,
                  content: batch[j].content,
                  chunk_index: i + j,
                  total_chunks: chunks.length,
                }
              };
              await vectorizeUpsert(env, [vector]);
              successCount++;
              errorCount--;
              console.log(`[R2_PROCESS] Individual chunk ${i + j + 1} succeeded`);
            } catch (individualError: any) {
              console.error(`[R2_PROCESS] Individual chunk ${i + j} failed:`, individualError.message);
            }
          }
        }
      }

      // Clean up R2 file after processing
      try {
        await env.DOCS_BUCKET.delete(sourceFilename);
        console.log(`[R2_PROCESS] Cleaned up R2 file: ${sourceFilename}`);
      } catch (cleanupError) {
        console.warn(`[R2_PROCESS] Failed to cleanup R2 file:`, cleanupError);
      }

      console.log(`[R2_PROCESS] Processing completed!`);
      console.log(`[R2_PROCESS] Final stats: ${successCount} successful, ${errorCount} failed out of ${chunks.length} total chunks`);

      return jsonResponse({
        ok: true,
        message: `Ingestion completed. Processed ${successCount} chunks successfully, ${errorCount} failed.`,
        stats: {
          filename: file.name,
          total_chunks: chunks.length,
          success_count: successCount,
          error_count: errorCount,
          file_size: file.size
        }
      });

    } catch (err: any) {
      console.error("[R2_PROCESS] Process file error:", err);
      return jsonResponse({ 
        error: `Failed to process file: ${err?.message ?? err}`,
        details: String(err)
      }, { status: 500 });
    }
  };
  
  // Race between processing and timeout
  try {
    return await Promise.race([processingPromise(), timeoutPromise]) as Response;
  } catch (err: any) {
    console.error("[R2_PROCESS] Processing failed or timed out:", err.message);
    return jsonResponse({ 
      error: `Processing failed or timed out: ${err?.message ?? err}`,
      timeout: err.message.includes('timeout')
    }, { status: 500 });
  }
}

async function handleIngest(request: Request, env: Env): Promise<Response> {
  if (!requireAuth(request, env.API_AUTH_TOKEN)) return unauthorized();
  const body = (await request.json()) as IngestRequestBody;
  if (!body?.id || !body?.text) return jsonResponse({ error: "Expected { id, text }" }, { status: 400 });

  const { id, text, title, source } = body;

  console.log(`[INGEST] Starting ingestion for document: ${id}`);
  console.log(`[INGEST] Original text length: ${text.length} characters`);
  
  // Clean text before chunking to prevent encoding issues
  const cleanedText = cleanText(text);
  console.log(`[INGEST] Cleaned text length: ${cleanedText.length} characters`);
  
  // Chunk
  const chunks = chunkText(cleanedText);
  console.log(`[INGEST] Generated ${chunks.length} chunks`);
  console.log(`[INGEST] Chunk size stats: min=${Math.min(...chunks.map(c => c.content.length))}, max=${Math.max(...chunks.map(c => c.content.length))}, avg=${Math.round(chunks.reduce((sum, c) => sum + c.content.length, 0) / chunks.length)}`);
  try { console.log("INGEST", JSON.stringify({ id, title, source, chunks: chunks.length })); } catch {}

  // Embed + upsert in batches (memory management for large files)
  const BATCH_SIZE = 25; // Process 25 chunks at a time to avoid memory issues
  const vectors: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }> = [];
  
  console.log(`[INGEST] Processing ${chunks.length} chunks in batches of ${BATCH_SIZE}...`);
  console.log(`[INGEST] Using embedding model: ${env.MODEL_EMBEDDING}`);
  
  for (let batchStart = 0; batchStart < chunks.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, chunks.length);
    const batchChunks = chunks.slice(batchStart, batchEnd);
    
    const batchNumber = Math.floor(batchStart / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);
    console.log(`[INGEST] Processing batch ${batchNumber}/${totalBatches} (chunks ${batchStart + 1}-${batchEnd}/${chunks.length})`);
    
    const batchVectors: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }> = [];
    
    for (let i = 0; i < batchChunks.length; i++) {
      const c = batchChunks[i];
      const globalIndex = batchStart + i;
      
      console.log(`[INGEST] Processing chunk ${globalIndex + 1}/${chunks.length} (length: ${c.content.length})`);
      
      // Clean chunk content as well
      const cleanedContent = cleanText(c.content);
      const emb = await embedText(env, cleanedContent);
      const vecId = `${id}::${globalIndex}`;
      
      console.log(`[INGEST] Chunk ${globalIndex + 1} embedded successfully (dim: ${emb.length})`);
      
      batchVectors.push({
        id: vecId,
        values: emb,
        metadata: {
          doc_id: id,
          title,
          source,
          chunk_index: globalIndex,
          offset: c.offset,
          length: c.length,
          content: cleanedContent,
        },
      });
    }
    
    // Upsert this batch
    console.log(`[INGEST] Upserting batch ${batchNumber} with ${batchVectors.length} vectors...`);
    await vectorizeUpsert(env, batchVectors);
    vectors.push(...batchVectors);
    
    console.log(`[INGEST] Batch ${batchNumber} completed: ${batchVectors.length} vectors upserted`);
  }

  console.log(`[INGEST] Final upsert with all ${vectors.length} vectors...`);
  await vectorizeUpsert(env, vectors);
  
  console.log(`[INGEST] Ingestion completed successfully!`);
  console.log(`[INGEST] Total chunks processed: ${chunks.length}`);
  console.log(`[INGEST] Total vectors upserted: ${vectors.length}`);
  if (vectors.length > 0) {
    console.log(`[INGEST] Vector dimensions: ${vectors[0]?.values?.length ?? 'unknown'}`);
  }
  
  try { console.log("UPSERT", JSON.stringify({ id, points: vectors.length, dim: vectors[0]?.values?.length ?? 0 })); } catch {}

  // Store raw text in R2 (optional but useful)
  try {
    console.log(`[INGEST] Storing raw text in R2: docs/${id}.txt`);
    await env.DOCS_BUCKET.put(`docs/${id}.txt`, text, { httpMetadata: { contentType: "text/plain;charset=utf-8" } });
    console.log(`[INGEST] Raw text stored successfully in R2`);
  } catch (err: any) {
    console.log(`[INGEST] Failed to store raw text in R2:`, err.message);
    // non-fatal
  }

  return jsonResponse({ ok: true, id, chunks: chunks.length, upserted: vectors.length });
}

async function handlePublicIngest(request: Request, env: Env): Promise<Response> {
  // Public ingestion endpoint for browser uploads (bypasses auth)
  console.log("PUBLIC INGEST: Request received");
  
  try {
    const body = (await request.json()) as IngestRequestBody;
    if (!body?.id || !body?.text) {
      console.log("PUBLIC INGEST: Missing required fields");
      return jsonResponse({ error: "Expected { id, text }" }, { status: 400 });
    }

    const { id, text, title, source } = body;
    console.log(`[PUBLIC_INGEST] Starting ingestion for ${id}, text length: ${text.length}`);
    console.log(`[PUBLIC_INGEST] Document title: ${title || 'N/A'}, source: ${source || 'N/A'}`);

    // Clean text before chunking to prevent encoding issues
    const cleanedText = cleanText(text);
    console.log(`[PUBLIC_INGEST] Cleaned text length: ${cleanedText.length} characters`);
    
    // Chunk
    const chunks = chunkText(cleanedText);
    console.log(`[PUBLIC_INGEST] Generated ${chunks.length} chunks`);
    console.log(`[PUBLIC_INGEST] Chunk size stats: min=${Math.min(...chunks.map(c => c.content.length))}, max=${Math.max(...chunks.map(c => c.content.length))}, avg=${Math.round(chunks.reduce((sum, c) => sum + c.content.length, 0) / chunks.length)}`);

    // Use larger batch size for faster processing  
    const PROCESSING_BATCH_SIZE = 25; // Increase batch size to reduce API calls
    const vectors: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }> = [];
    
    console.log(`[PUBLIC_INGEST] Processing ${chunks.length} chunks using batch embedding...`);
    console.log(`[PUBLIC_INGEST] Using embedding model: ${env.MODEL_EMBEDDING}`);
    
    for (let batchStart = 0; batchStart < chunks.length; batchStart += PROCESSING_BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + PROCESSING_BATCH_SIZE, chunks.length);
      const batchChunks = chunks.slice(batchStart, batchEnd);
      
      console.log(`PUBLIC INGEST: Processing batch ${Math.floor(batchStart / PROCESSING_BATCH_SIZE) + 1}/${Math.ceil(chunks.length / PROCESSING_BATCH_SIZE)} (${batchStart + 1}-${batchEnd}/${chunks.length})`);
      
      try {
        // Clean all chunk contents
        const cleanedContents = batchChunks.map(c => cleanText(c.content));
        
        // Use batch embedding for efficiency and rate limiting
        const embeddings = await embedTextBatch(env, cleanedContents);
        
        // Create vectors for this batch
        const batchVectors: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }> = [];
        
        for (let i = 0; i < batchChunks.length; i++) {
          const c = batchChunks[i];
          const globalIndex = batchStart + i;
          const vecId = `${id}::${globalIndex}`;
          
          // Use the embedding from batch processing
          const embedding = embeddings[i] || new Array(1024).fill(0); // Fallback to zero vector
          
          batchVectors.push({
            id: vecId,
            values: embedding,
            metadata: {
              doc_id: id,
              title,
              source,
              chunk_index: globalIndex,
              offset: c.offset,
              length: c.length,
              content: cleanedContents[i],
            },
          });
        }
        
        // Upsert this batch
        if (batchVectors.length > 0) {
          await vectorizeUpsert(env, batchVectors);
          vectors.push(...batchVectors);
          console.log(`PUBLIC INGEST: Batch ${Math.floor(batchStart / PROCESSING_BATCH_SIZE) + 1} completed: ${batchVectors.length} vectors upserted`);
        }
        
      } catch (batchError: any) {
        console.log(`PUBLIC INGEST: Batch ${Math.floor(batchStart / PROCESSING_BATCH_SIZE) + 1} failed:`, batchError.message);
        
        // Fallback to individual processing with longer delays
        console.log(`PUBLIC INGEST: Falling back to individual processing for this batch...`);
        
        const batchVectors: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }> = [];
        
        for (let i = 0; i < batchChunks.length; i++) {
          const c = batchChunks[i];
          const globalIndex = batchStart + i;
          
          try {
            const cleanedContent = cleanText(c.content);
            console.log(`PUBLIC INGEST: Individual embedding for chunk ${globalIndex + 1}/${chunks.length}...`);
            
            const emb = await embedTextSingle(env, cleanedContent);
            const vecId = `${id}::${globalIndex}`;
            
            batchVectors.push({
              id: vecId,
              values: emb,
              metadata: {
                doc_id: id,
                title,
                source,
                chunk_index: globalIndex,
                offset: c.offset,
                length: c.length,
                content: cleanedContent,
              },
            });
            
            console.log(`PUBLIC INGEST: Chunk ${globalIndex + 1} embedded individually`);
            
            // Rate limiting delay between individual requests (50 requests/second max)
            await new Promise(resolve => setTimeout(resolve, 1200));
            
          } catch (individualError: any) {
            console.log(`PUBLIC INGEST: Individual embedding failed for chunk ${globalIndex + 1}, using zero vector`);
            
            // Use zero vector as ultimate fallback
            const vecId = `${id}::${globalIndex}`;
            batchVectors.push({
              id: vecId,
              values: new Array(1024).fill(0),
              metadata: {
                doc_id: id,
                title,
                source,
                chunk_index: globalIndex,
                offset: c.offset,
                length: c.length,
                content: cleanText(c.content),
              },
            });
          }
        }
        
        // Upsert whatever we managed to process
        if (batchVectors.length > 0) {
          await vectorizeUpsert(env, batchVectors);
          vectors.push(...batchVectors);
          console.log(`PUBLIC INGEST: Individual fallback completed: ${batchVectors.length} vectors upserted`);
        }
      }
    }

  console.log(`PUBLIC INGEST: All batches completed. Total vectors: ${vectors.length}`);

  // Store raw text in R2 (optional but useful)
  try {
    await env.DOCS_BUCKET.put(`docs/${id}.txt`, cleanedText, { httpMetadata: { contentType: "text/plain;charset=utf-8" } });
    console.log(`PUBLIC INGEST: Stored raw text in R2`);
  } catch (err) {
    console.log(`PUBLIC INGEST: Failed to store in R2:`, err);
    // non-fatal
  }

    console.log(`PUBLIC INGEST: Ingestion completed successfully`);
    return jsonResponse({ ok: true, id, chunks: chunks.length, upserted: vectors.length });
    
  } catch (error: any) {
    console.log(`PUBLIC INGEST: Fatal error during ingestion:`, error.message);
    console.log(`PUBLIC INGEST: Error details:`, error);
    
    // Return a proper error response instead of throwing
    return jsonResponse({ 
      error: "Ingestion failed", 
      details: error.message,
      suggestion: "The AI model may be temporarily unavailable. Please try again in a few minutes."
    }, { status: 500 });
  }
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

  // ============================================================================
  // 🆕 HUMAN-IN-THE-LOOP: Check correction cache FIRST
  // ============================================================================
  const userQuery = String(lastUser.content || "").trim();
  const cacheHit = await checkCorrectionCache(env, userQuery);
  
  if (cacheHit.found && cacheHit.correction) {
    console.log(`[CHAT] 🎯 Returning corrected answer from cache (confidence: ${cacheHit.confidence.toFixed(3)})`);
    
    // Build response metadata
    const metadata: ChatResponseMetadata = {
      source: "correction_cache",
      verified: true,
      confidence: cacheHit.confidence,
      correctionId: cacheHit.correction.id,
      timesReused: cacheHit.correction.timesReused,
      originallyWrong: cacheHit.correction.wrongAnswer,
    };
    
    // Create chat response with corrected answer
    const chatResponse: ChatResponse & { metadata?: ChatResponseMetadata } = {
      conversationId,
      answer: cacheHit.correction.correctAnswer,
      citations: [], // Corrected answers don't have citations unless we add them
      metadata,
    };
    
    // Persist assistant message
    await appendMessage(env, conversationId, { role: "assistant", content: chatResponse.answer });
    
    const response = jsonResponse(chatResponse);
    if (setCookieHeader) response.headers.set("set-cookie", setCookieHeader);
    return response;
  }
  
  console.log(`[CHAT] 🔍 No correction found in cache, proceeding with normal RAG flow`);

  // ============================================================================
  // Standard RAG Flow (when no correction exists)
  // ============================================================================
  // --- CrewAI Orchestrator ---
  const orchestrator = new AgentOrchestrator();
  const t0 = Date.now();
  let chatResponse: ChatResponse;
  try {
    chatResponse = await orchestrator.processQuery(env, conversationId, userQuery, undefined, undefined, maxIter);
  } catch (err: any) {
    console.log("[Orchestrator] ERROR", err);
    return jsonResponse({ error: String(err?.message ?? err) }, { status: 500 });
  }
  const ms = Date.now() - t0;
  try { console.log("CREWAI_CHAT_ANSWER", JSON.stringify({ conversationId, ms, chars: chatResponse.answer.length, citations: chatResponse.citations.length })); } catch {}

  // Add metadata indicating this is from RAG (not verified)
  const ragMetadata: ChatResponseMetadata = {
    source: "rag",
    verified: false,
  };
  
  const responseWithMeta = { ...chatResponse, metadata: ragMetadata };

  // Persist assistant message and citations
  await appendMessage(env, conversationId, { role: "assistant", content: chatResponse.answer });
  try {
    const convAfter = await getConversation(env, conversationId);
    if (convAfter) {
      convAfter.lastCitations = chatResponse.citations;
      await saveConversation(env, convAfter);
    }
  } catch {}
  const base = jsonResponse(responseWithMeta);
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

  const answer = await synthesize(env, query, contextBlocks);
  const ms = Date.now() - t0;
  try { console.log("RAG_ANSWER", JSON.stringify({ ms, chars: answer.answer?.length || 0, citations: contextBlocks.length })); } catch {}

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
      if (url.pathname === "/upload-r2" && request.method === "POST") return handleR2Upload(request, env);
      if (url.pathname === "/process-r2" && request.method === "POST") return handleR2Process(request, env);
      if (url.pathname === "/ingest" && request.method === "POST") return handleIngest(request, env);
      if (url.pathname === "/ingest-public" && request.method === "POST") return handlePublicIngest(request, env);
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
      
      // Debug endpoints for BGE-Large response format testing
      if (url.pathname === "/debug/single-embedding" && request.method === "POST") {
        const { text } = await request.json() as { text: string };
        try {
          const res = await env.AI.run(env.MODEL_EMBEDDING, { text });
          return jsonResponse({
            success: true,
            raw_response: res,
            response_type: typeof res,
            response_keys: Object.keys(res || {}),
            response_structure: JSON.stringify(res, null, 2)
          });
        } catch (error: any) {
          return jsonResponse({ error: error.message }, { status: 500 });
        }
      }
      
      if (url.pathname === "/debug/batch-embedding" && request.method === "POST") {
        const { texts } = await request.json() as { texts: string[] };
        try {
          const res = await env.AI.run(env.MODEL_EMBEDDING, { text: texts });
          return jsonResponse({
            success: true,
            input_count: texts.length,
            raw_response: res,
            response_type: typeof res,
            response_keys: Object.keys(res || {}),
            response_structure: JSON.stringify(res, null, 2)
          });
        } catch (error: any) {
          return jsonResponse({ error: error.message }, { status: 500 });
        }
      }
      
      // Document management endpoints
      if (url.pathname === "/debug/list-documents" && request.method === "GET") {
        return handleListDocuments(request, env);
      }
      
      if (url.pathname === "/debug/document-stats" && request.method === "GET") {
        return handleDocumentStats(request, env);
      }
      
      if (url.pathname === "/admin/delete-document" && request.method === "DELETE") {
        if (!requireAuth(request, env.API_AUTH_TOKEN)) return unauthorized();
        return handleDeleteDocument(request, env);
      }
      
      if (url.pathname === "/admin/cleanup-all" && request.method === "DELETE") {
        if (!requireAuth(request, env.API_AUTH_TOKEN)) return unauthorized();
        return handleCleanupAll(request, env);
      }
      
      // ========================================================================
      // Human-in-the-Loop Correction Endpoints
      // ========================================================================
      
      // Submit a correction for a wrong answer
      if (url.pathname === "/api/feedback/correct" && request.method === "POST") {
        const { userId } = getOrSetUserIdCookie(request);
        const body = (await request.json().catch(() => ({}))) as CorrectionFeedbackRequest;
        
        if (!body.originalQuery || !body.wrongAnswer || !body.correctAnswer) {
          return jsonResponse({ 
            error: "Missing required fields: originalQuery, wrongAnswer, correctAnswer" 
          }, { status: 400 });
        }
        
        const result = await storeCorrectionInCache(env, {
          originalQuery: body.originalQuery,
          wrongAnswer: body.wrongAnswer,
          correctAnswer: body.correctAnswer,
          questionVariants: body.questionVariants,
          correctedBy: userId || "anonymous",
          wrongAnswerSources: body.wrongAnswerSources,
          correctAnswerSource: body.correctAnswerSource,
          notes: body.notes,
        });
        
        if (!result.success) {
          return jsonResponse({ 
            ok: false, 
            error: result.error || "Failed to store correction" 
          }, { status: 500 });
        }
        
        return jsonResponse({ 
          ok: true, 
          correctionId: result.id,
          message: "Correction saved successfully. Thank you for improving the system!" 
        });
      }
      
      // Get correction cache statistics
      if (url.pathname === "/api/corrections/stats" && request.method === "GET") {
        const stats = await getCorrectionStats(env);
        return jsonResponse({ ok: true, stats });
      }
      
      // Debug endpoint: Test cache lookup
      if (url.pathname === "/api/corrections/debug-lookup" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { query: string };
        if (!body.query) {
          return jsonResponse({ error: "Missing query parameter" }, { status: 400 });
        }
        
        const cacheHit = await checkCorrectionCache(env, body.query);
        return jsonResponse({ 
          ok: true, 
          query: body.query,
          cacheHit,
          threshold: Number(env.CORRECTION_MATCH_THRESHOLD || "0.90")
        });
      }
      
      // Get a specific correction by ID
      if (url.pathname.startsWith("/api/corrections/") && request.method === "GET") {
        const correctionId = url.pathname.split("/")[3] || "";
        if (!correctionId || correctionId === "stats") {
          return jsonResponse({ error: "Missing correctionId" }, { status: 400 });
        }
        
        const correction = await getCorrectionById(env, correctionId);
        if (!correction) {
          return jsonResponse({ error: "Correction not found" }, { status: 404 });
        }
        
        return jsonResponse({ ok: true, correction });
      }
      
      // Delete a correction (admin only)
      if (url.pathname.startsWith("/api/corrections/") && request.method === "DELETE") {
        if (!requireAuth(request, env.API_AUTH_TOKEN)) return unauthorized();
        
        const correctionId = url.pathname.split("/")[3] || "";
        if (!correctionId) {
          return jsonResponse({ error: "Missing correctionId" }, { status: 400 });
        }
        
        const result = await deleteCorrectionById(env, correctionId);
        if (!result.success) {
          return jsonResponse({ 
            ok: false, 
            error: result.error || "Failed to delete correction" 
          }, { status: 500 });
        }
        
        return jsonResponse({ ok: true, message: "Correction deleted successfully" });
      }
      
      return jsonResponse({ error: "Not found" }, { status: 404 });
    } catch (err: any) {
      return jsonResponse({ error: String(err?.message ?? err) }, { status: 500 });
    }
  }
}; 