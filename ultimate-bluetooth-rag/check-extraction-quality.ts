// Script to check PDF extraction quality
// Usage: npx tsx check-extraction-quality.ts

const ENDPOINT = 'https://bt-rag.hybridrag.workers.dev'; // Your actual endpoint

async function checkExtractionQuality() {
  console.log('🔍 Checking PDF Extraction Quality...\n');

  // 1. Check what was actually stored in the vector database
  console.log('1. Testing search to see what content was stored...');
  
  const searchQueries = [
    'Bluetooth',
    'specification', 
    'protocol',
    'version',
    'core',
    'page',
    'section',
    'chapter'
  ];

  for (const query of searchQueries) {
    try {
      const response = await fetch(`${ENDPOINT}/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          question: `What information do you have about ${query}?`,
          max_results: 10 // Get more results to see coverage
        })
      });

      if (response.ok) {
        const result = await response.json();
        console.log(`\n📖 Query "${query}":`);
        console.log(`   Answer length: ${result.answer?.length || 0} characters`);
        console.log(`   Sources found: ${result.sources?.length || 0}`);
        
        if (result.sources && result.sources.length > 0) {
          console.log(`   Source chunks: ${result.sources.map((s: any, i: number) => 
            `${i+1}. "${s.content?.substring(0, 100)}..."`).join('\n                  ')}`);
        }
      }
    } catch (error: any) {
      console.log(`   ❌ Search failed: ${error.message}`);
    }
  }

  // 2. Check R2 storage for the original file
  console.log('\n\n2. Checking if original document is stored in R2...');
  try {
    const response = await fetch(`${ENDPOINT}/api/docs/Core_v6.1-224-428.pdf.txt`);
    if (response.ok) {
      const content = await response.text();
      console.log(`✅ Found stored document: ${content.length} characters`);
      console.log(`📄 Preview (first 500 chars):\n${content.substring(0, 500)}...`);
      
      // Estimate expected chunks
      const expectedChunks = Math.ceil(content.length / 1200); // Default chunk size
      console.log(`📊 Expected chunks for this content: ~${expectedChunks}`);
      console.log(`📊 Actually processed: 4 chunks`);
      console.log(`⚠️  Extraction efficiency: ${((4 / expectedChunks) * 100).toFixed(1)}%`);
    } else {
      console.log(`❌ Original document not found in R2 storage`);
    }
  } catch (error: any) {
    console.log(`❌ R2 check failed: ${error.message}`);
  }

  // 3. Direct vectorize query to see what's actually indexed
  console.log('\n\n3. Checking vector database contents...');
  try {
    // This would need to be implemented in the worker if not already available
    const response = await fetch(`${ENDPOINT}/debug/vector-stats`, {
      method: 'GET'
    });
    
    if (response.ok) {
      const stats = await response.json();
      console.log(`✅ Vector database stats:`, JSON.stringify(stats, null, 2));
    } else {
      console.log(`ℹ️  Vector debug endpoint not available (${response.status})`);
    }
  } catch (error: any) {
    console.log(`ℹ️  Vector stats not accessible: ${error.message}`);
  }

  // 4. Test comprehensive search
  console.log('\n\n4. Testing comprehensive content search...');
  const comprehensiveQuery = 'Give me a detailed summary of all the content you have from this Bluetooth specification document, including any section numbers, version information, and key topics covered.';
  
  try {
    const response = await fetch(`${ENDPOINT}/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        question: comprehensiveQuery,
        max_results: 20 // Get maximum results
      })
    });

    if (response.ok) {
      const result = await response.json();
      console.log(`📋 Comprehensive summary (${result.answer?.length || 0} chars):`);
      console.log(result.answer || 'No content found');
      console.log(`\n📊 Total sources used: ${result.sources?.length || 0}`);
    }
  } catch (error: any) {
    console.log(`❌ Comprehensive search failed: ${error.message}`);
  }

  console.log('\n\n🎯 Recommendations:');
  console.log('If you see limited content:');
  console.log('1. 📄 Convert PDF to text: Open PDF → Select All → Copy → Paste to .txt file');
  console.log('2. 📤 Re-upload the .txt version for full processing');
  console.log('3. 🔍 Use online PDF-to-text converters for better extraction');
  console.log('4. 📊 A 200-page PDF should generate 200+ chunks for full coverage');
}

checkExtractionQuality().catch(console.error);



