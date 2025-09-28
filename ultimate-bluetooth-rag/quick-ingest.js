// Quick ingest script - much faster than R2 processing
// Usage: node quick-ingest.cjs <folder_path>
// Example: node quick-ingest.cjs "./documents"

const fs = require('fs');
const path = require('path');

async function quickIngest() {
  console.log('🚀 Quick Direct Ingestion with Folder Processing...\n');
  
  // Get folder path from command line arguments
  const folderPath = process.argv[2];
  
  if (!folderPath) {
    console.log('❌ Please provide a folder path!');
    console.log('Usage: node quick-ingest.js <folder_path>');
    console.log('Example: node quick-ingest.js "./documents"');
    console.log('         node quick-ingest.js "C:\\Users\\Documents\\PDFs"');
    return;
  }
  
  console.log(`📂 Processing folder: ${folderPath}`);
  
  // Check if folder exists
  if (!fs.existsSync(folderPath)) {
    console.log('❌ Folder does not exist:', folderPath);
    return;
  }
  
  // Read all files from folder
  let files;
  try {
    files = fs.readdirSync(folderPath);
    console.log(`📋 Found ${files.length} files in folder`);
  } catch (error) {
    console.log('❌ Cannot read folder:', error.message);
    return;
  }
  
  // Filter supported file types
  const supportedExtensions = ['.txt', '.md', '.tex'];
  const supportedFiles = files.filter(file => {
    const ext = path.extname(file).toLowerCase();
    return supportedExtensions.includes(ext);
  });
  
  console.log(`📄 Found ${supportedFiles.length} supported files:`, supportedFiles.map(f => `\n  - ${f}`).join(''));
  
  if (supportedFiles.length === 0) {
    console.log('❌ No supported files found (.txt, .md, .tex)');
    console.log('💡 Convert PDFs to text first or add them to the supportedExtensions array');
    return;
  }
  
  // Process each file
  let totalContent = '';
  let fileContents = [];
  
  for (const file of supportedFiles) {
    const filePath = path.join(folderPath, file);
    console.log(`\n📖 Reading: ${file}`);
    
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      console.log(`  ✅ Read ${content.length} characters`);
      
      fileContents.push({
        filename: file,
        content: content,
        size: content.length
      });
      
      totalContent += `\n\n=== ${file} ===\n\n${content}`;
      
    } catch (error) {
      console.log(`  ❌ Failed to read ${file}:`, error.message);
    }
  }
  
  console.log(`\n📊 Total content: ${totalContent.length} characters from ${fileContents.length} files`);

  // Create unique ID based on folder name
  const folderName = path.basename(folderPath);
  const timestamp = Date.now();
  
  const payload = {
    id: `folder-${folderName}-${timestamp}`,
    text: totalContent,
    title: `Documents from ${folderName}`,
    source: `Folder: ${folderPath} (${fileContents.length} files)`
  };

  console.log('\n📤 Preparing to send to public ingest endpoint...');
  console.log(`🆔 Document ID: ${payload.id}`);
  console.log(`📝 Title: ${payload.title}`);
  console.log(`📂 Source: ${payload.source}`);
  console.log(`📏 Total size: ${Math.round(totalContent.length / 1024)} KB`);
  
  const startTime = Date.now();
  console.log('\n⏳ Sending to ingestion endpoint...');
  
  try {
    const response = await fetch('https://bt-rag.hybridrag.workers.dev/ingest-public', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const duration = Date.now() - startTime;
    console.log(`⏱️  Request completed in ${Math.round(duration/1000)}s`);

    if (!response.ok) {
      console.log('❌ HTTP Error:', response.status, response.statusText);
      const errorText = await response.text();
      console.log('Error details:', errorText);
      return;
    }

    const result = await response.json();
    
    console.log('\n🎉 SUCCESS! Document ingested successfully!');
    console.log(`⏱️  Total time: ${Math.round(duration/1000)} seconds`);
    console.log(`📊 Processing results:`);
    
    if (result.chunks !== undefined) {
      console.log(`  📄 Chunks created: ${result.chunks}`);
    }
    if (result.upserted !== undefined) {
      console.log(`  💾 Vectors stored: ${result.upserted}`);
    }
    
    console.log('\n📋 File breakdown:');
    fileContents.forEach(file => {
      console.log(`  - ${file.filename}: ${Math.round(file.size/1024)} KB`);
    });
    
    console.log('\n✨ Your documents are now searchable in the RAG system!');
    console.log(`🔍 Test with queries about: ${fileContents.map(f => path.parse(f.filename).name).join(', ')}`);
    
  } catch (error) {
    console.log('\n❌ Network/Connection error:', error.message);
    console.log('💡 Make sure your internet connection is working and the endpoint is accessible');
  }
}

quickIngest();
