// Admin functions for managing RAG resources
import type { Env } from "./types";

function jsonResponse(obj: any, init?: ResponseInit): Response {
  return new Response(JSON.stringify(obj), {
    headers: { 'content-type': 'application/json', ...init?.headers },
    ...init
  });
}

export async function handleListDocuments(request: Request, env: Env): Promise<Response> {
  try {
    console.log(`[LIST_DOCS] Starting comprehensive document discovery...`);
    
    // Method 1: Multiple vector similarity searches to catch different embeddings
    const vectors = [
      new Array(1024).fill(0.1),  // Low values
      new Array(1024).fill(0.5),  // Medium values  
      new Array(1024).fill(0.9),  // High values
      new Array(1024).fill(0).map((_, i) => i % 2 === 0 ? 0.3 : 0.7), // Alternating
      new Array(1024).fill(0).map(() => Math.random() * 0.5 + 0.25), // Random 1
      new Array(1024).fill(0).map(() => Math.random() * 0.5 + 0.25), // Random 2
      new Array(1024).fill(0).map(() => Math.random() * 0.5 + 0.25)  // Random 3
    ];
    
    let allResults: any[] = [];
    
    // Try vector searches first
    for (let i = 0; i < vectors.length; i++) {
      const vector = vectors[i];
      try {
        const results = await env.VECTORIZE_INDEX.query(vector, {
          topK: 100, // Increase to catch more docs
          returnValues: false,
          returnMetadata: "all"
        });
        allResults.push(...results.matches);
        console.log(`[LIST_DOCS] Vector ${i+1} found ${results.matches.length} matches`);
        
        // Break early if we found a good amount
        if (allResults.length > 300) break;
      } catch (queryError: any) {
        console.log(`[LIST_DOCS] Vector ${i+1} query failed:`, queryError.message);
        // Fallback to indexed metadata
        try {
          const results = await env.VECTORIZE_INDEX.query(vector, {
            topK: 100,
            returnValues: false,
            returnMetadata: "indexed"
          });
          allResults.push(...results.matches);
          console.log(`[LIST_DOCS] Vector ${i+1} fallback found ${results.matches.length} matches`);
        } catch (fallbackError: any) {
          console.log(`[LIST_DOCS] Vector ${i+1} fallback also failed:`, fallbackError.message);
        }
      }
    }
    
    // Method 2: Also check R2 bucket for uploaded files (as backup reference)
    let r2DocIds: string[] = [];
    try {
      const r2Objects = await env.DOCS_BUCKET.list({ prefix: 'docs/' });
      r2DocIds = r2Objects.objects.map(obj => {
        const filename = obj.key.replace('docs/', '').replace(/\.(txt|pdf|md|tex|docx)$/, '');
        return filename;
      });
      console.log(`[LIST_DOCS] Found ${r2DocIds.length} documents in R2: ${r2DocIds.join(', ')}`);
    } catch (r2Error: any) {
      console.log(`[LIST_DOCS] R2 listing failed (non-fatal):`, r2Error.message);
    }
    
    console.log(`[LIST_DOCS] Total vector matches found: ${allResults.length}`);

    // Remove duplicates and group by document ID
    const uniqueMatches = Array.from(new Map(allResults.map(m => [m.id, m])).values());
    console.log(`[LIST_DOCS] Unique matches after dedup: ${uniqueMatches.length}`);
    
    const docGroups: Record<string, any> = {};
    
    uniqueMatches.forEach(match => {
      const docId = match.metadata?.doc_id as string;
      if (docId) {
        if (!docGroups[docId]) {
          docGroups[docId] = {
            doc_id: docId,
            title: match.metadata?.title,
            source: match.metadata?.source,
            chunks: [],
            total_size: 0
          };
        }
        docGroups[docId].chunks.push(match.id);
        if (match.metadata?.content) {
          docGroups[docId].total_size += (match.metadata.content as string).length;
        }
      }
    });

    let documents = Object.values(docGroups).map(doc => ({
      doc_id: doc.doc_id,
      title: doc.title,
      source: doc.source,
      chunk_count: doc.chunks.length,
      total_size: doc.total_size
    }));

    // Add any R2 documents that weren't found in vector search (orphaned uploads)
    for (const r2Id of r2DocIds) {
      if (!documents.find(doc => doc.doc_id === r2Id)) {
        console.log(`[LIST_DOCS] Found orphaned R2 document: ${r2Id}`);
        documents.push({
          doc_id: r2Id,
          title: `${r2Id} (R2 only)`,
          source: 'R2 Storage',
          chunk_count: 0,
          total_size: 0
        });
      }
    }
    
    // Sort by chunk count (most processed first)
    documents = documents.sort((a, b) => b.chunk_count - a.chunk_count);
    
    console.log(`[LIST_DOCS] Returning ${documents.length} documents total`);
    documents.forEach(doc => {
      console.log(`[LIST_DOCS] - ${doc.doc_id}: ${doc.chunk_count} chunks, ${Math.round(doc.total_size/1024)}KB`);
    });

    return jsonResponse(documents);
  } catch (error: any) {
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}

export async function handleDocumentStats(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const docId = url.searchParams.get('doc_id');
  
  if (!docId) {
    return jsonResponse({ error: 'doc_id parameter required' }, { status: 400 });
  }

  try {
    // Query for this specific document
    const dummyVector = new Array(1024).fill(0.1);
    const results = await env.VECTORIZE_INDEX.query(dummyVector, {
      topK: 100,
      returnValues: false,
      returnMetadata: "indexed",
      filter: { doc_id: { $eq: docId } }
    });

    if (results.matches.length === 0) {
      return jsonResponse({ error: 'Document not found' }, { status: 404 });
    }

    let totalSize = 0;
    results.matches.forEach(match => {
      if (match.metadata?.content) {
        totalSize += (match.metadata.content as string).length;
      }
    });

    return jsonResponse({
      doc_id: docId,
      chunk_count: results.matches.length,
      total_size: totalSize,
      title: results.matches[0]?.metadata?.title,
      source: results.matches[0]?.metadata?.source
    });
  } catch (error: any) {
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}

export async function handleDeleteDocument(request: Request, env: Env): Promise<Response> {
  try {
    const { doc_id } = await request.json() as { doc_id: string };
    
    if (!doc_id) {
      return jsonResponse({ error: 'doc_id required' }, { status: 400 });
    }

    console.log(`[ADMIN] Deleting document: ${doc_id}`);

    // First, find all chunks for this document
    const dummyVector = new Array(1024).fill(0.1);
    const results = await env.VECTORIZE_INDEX.query(dummyVector, {
      topK: 100,
      returnValues: false,
      returnMetadata: "indexed",
      filter: { doc_id: { $eq: doc_id } }
    });

    if (results.matches.length === 0) {
      return jsonResponse({ error: 'Document not found' }, { status: 404 });
    }

    console.log(`[ADMIN] Found ${results.matches.length} chunks to delete`);

    // Delete vectors in batches
    const deleteIds = results.matches.map(m => m.id);
    const BATCH_SIZE = 100;
    let deletedCount = 0;

    for (let i = 0; i < deleteIds.length; i += BATCH_SIZE) {
      const batch = deleteIds.slice(i, i + BATCH_SIZE);
      try {
        await env.VECTORIZE_INDEX.deleteByIds(batch);
        deletedCount += batch.length;
        console.log(`[ADMIN] Deleted batch: ${deletedCount}/${deleteIds.length}`);
      } catch (error: any) {
        console.log(`[ADMIN] Batch delete failed:`, error.message);
      }
    }

    // Also try to delete from R2 if it exists
    try {
      await env.DOCS_BUCKET.delete(`docs/${doc_id}.txt`);
      console.log(`[ADMIN] Deleted R2 file: docs/${doc_id}.txt`);
    } catch (error) {
      console.log(`[ADMIN] R2 file not found or delete failed (non-fatal)`);
    }

    return jsonResponse({
      success: true,
      deleted_chunks: deletedCount,
      doc_id: doc_id
    });

  } catch (error: any) {
    console.log(`[ADMIN] Delete document error:`, error.message);
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}

export async function handleCleanupAll(request: Request, env: Env): Promise<Response> {
  try {
    console.log(`[ADMIN] Starting complete cleanup - deleting ALL documents`);

    // This is a dangerous operation - delete all vectors
    // Note: Vectorize doesn't have a "delete all" method, so we need to find and delete
    
    const dummyVector = new Array(1024).fill(0.1);
    let totalDeleted = 0;
    let hasMore = true;

    while (hasMore) {
      const results = await env.VECTORIZE_INDEX.query(dummyVector, {
        topK: 100,
        returnValues: false,
        returnMetadata: false
      });

      if (results.matches.length === 0) {
        hasMore = false;
        break;
      }

      const deleteIds = results.matches.map(m => m.id);
      
      try {
        await env.VECTORIZE_INDEX.deleteByIds(deleteIds);
        totalDeleted += deleteIds.length;
        console.log(`[ADMIN] Cleanup progress: ${totalDeleted} vectors deleted`);
      } catch (error: any) {
        console.log(`[ADMIN] Cleanup batch failed:`, error.message);
        break;
      }

      // If we got fewer than requested, we're probably done
      if (results.matches.length < 1000) {
        hasMore = false;
      }
    }

    console.log(`[ADMIN] Cleanup complete: ${totalDeleted} total vectors deleted`);

    return jsonResponse({
      success: true,
      deleted_vectors: totalDeleted,
      message: 'All documents and vectors have been deleted'
    });

  } catch (error: any) {
    console.log(`[ADMIN] Cleanup error:`, error.message);
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}
