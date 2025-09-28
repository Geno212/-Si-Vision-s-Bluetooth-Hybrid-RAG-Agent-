// Add this to your src/index.ts to create debug endpoints for checking content

// Add this function to your index.ts file:

/*
async function handleDebugVectorStats(request: Request, env: Env): Promise<Response> {
  try {
    // Query vectorize to get some stats about stored vectors
    const sampleQuery = new Array(1024).fill(0.1); // Sample vector for querying
    
    const results = await env.VECTORIZE_INDEX.query(sampleQuery, {
      topK: 100, // Get more results to see what's stored
      returnValues: false,
      returnMetadata: true
    });

    const stats = {
      total_vectors_found: results.matches.length,
      score_range: {
        min: Math.min(...results.matches.map(m => m.score)),
        max: Math.max(...results.matches.map(m => m.score))
      },
      sample_sources: results.matches.slice(0, 10).map(match => ({
        id: match.id,
        score: match.score,
        title: match.metadata?.title,
        source: match.metadata?.source,
        chunk_index: match.metadata?.chunk_index,
        content_preview: typeof match.metadata?.content === 'string' 
          ? (match.metadata.content as string).substring(0, 100) + '...'
          : 'No content preview'
      })),
      document_distribution: {}
    };

    // Count chunks per document
    results.matches.forEach(match => {
      const source = match.metadata?.source as string || 'unknown';
      stats.document_distribution[source] = (stats.document_distribution[source] || 0) + 1;
    });

    return jsonResponse(stats);
  } catch (err: any) {
    return jsonResponse({ error: err.message }, { status: 500 });
  }
}

// Add this to your router:
if (url.pathname === '/debug/vector-stats') {
  return handleDebugVectorStats(request, env);
}

// Also add an endpoint to check R2 stored content:
async function handleDebugR2Content(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const filename = url.searchParams.get('filename');
  
  if (!filename) {
    return jsonResponse({ error: 'Provide ?filename=xxx parameter' }, { status: 400 });
  }

  try {
    const object = await env.DOCS_BUCKET.get(`docs/${filename}`);
    if (!object) {
      return jsonResponse({ error: 'File not found' }, { status: 404 });
    }

    const content = await object.text();
    return jsonResponse({
      filename,
      size: content.length,
      preview: content.substring(0, 1000),
      char_count: content.length,
      estimated_chunks: Math.ceil(content.length / 1200)
    });
  } catch (err: any) {
    return jsonResponse({ error: err.message }, { status: 500 });
  }
}

// Add this route:
if (url.pathname === '/debug/r2-content') {
  return handleDebugR2Content(request, env);
}
*/

console.log('📝 Copy the above code to your src/index.ts file to add debug endpoints');
console.log('Then you can check:');
console.log('- /debug/vector-stats - See what vectors are stored');
console.log('- /debug/r2-content?filename=Core_v6.1-224-428.pdf.txt - Check stored text content');



