// Test script to check BGE-Large response format
// Usage: npx tsx test-bge-response-format.ts

async function testBGEResponseFormat() {
  console.log('🔬 Testing BGE-Large Response Format...\n');
  
  const ENDPOINT = 'https://bt-rag.hybridrag.workers.dev';
  
  // Test with a simple text to see response format
  const testTexts = [
    'Hello world, this is a test.',
    'Bluetooth is a wireless communication protocol.',
    'This is a third test sentence.'
  ];
  
  try {
    // First, let's try the individual embedding to see single response format
    console.log('1. Testing single text embedding...');
    const singleResponse = await fetch(`${ENDPOINT}/debug/single-embedding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: testTexts[0] })
    });
    
    if (singleResponse.ok) {
      const singleResult = await singleResponse.json();
      console.log('Single embedding response:', JSON.stringify(singleResult, null, 2));
    } else {
      console.log('Single embedding not available');
    }
    
    // Test batch embedding to see batch response format
    console.log('\n2. Testing batch text embedding...');
    const batchResponse = await fetch(`${ENDPOINT}/debug/batch-embedding`, {
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: testTexts })
    });
    
    if (batchResponse.ok) {
      const batchResult = await batchResponse.json();
      console.log('Batch embedding response:', JSON.stringify(batchResult, null, 2));
    } else {
      console.log('Batch embedding not available');
    }
    
    console.log('\n3. Direct model testing (if endpoints don\'t exist)...');
    console.log('Add these debug endpoints to your worker to test:');
    console.log(`
// Add to src/index.ts:

async function handleDebugSingleEmbedding(request: Request, env: Env): Promise<Response> {
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

async function handleDebugBatchEmbedding(request: Request, env: Env): Promise<Response> {
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

// Add routes:
if (url.pathname === '/debug/single-embedding') {
  return handleDebugSingleEmbedding(request, env);
}
if (url.pathname === '/debug/batch-embedding') {
  return handleDebugBatchEmbedding(request, env);
}
    `);
    
  } catch (error: any) {
    console.log('❌ Test failed:', error.message);
  }
  
  console.log('\n🎯 Next steps:');
  console.log('1. Add the debug endpoints to your worker');
  console.log('2. Deploy: wrangler deploy');
  console.log('3. Run this test again');
  console.log('4. The response format will be revealed in the logs');
}

testBGEResponseFormat().catch(console.error);



