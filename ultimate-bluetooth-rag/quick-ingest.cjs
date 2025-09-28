// Quick ingest script - much faster than R2 processing
// Usage: node quick-ingest.cjs <path>
// Works with both files and folders
// Examples: 
//   node quick-ingest.cjs "./documents"
//   node quick-ingest.cjs "C:\path\to\file.txt"

const fs = require('fs');
const path = require('path');

// Configuration for large document handling
const CONFIG = {
  MAX_CHUNK_SIZE: 300000, // 300KB per chunk (characters)
  MAX_REQUEST_TIMEOUT: 60000, // 60 seconds
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 2000 // 2 seconds base delay
};

// Utility function to chunk large text
function chunkText(text, maxSize) {
  if (text.length <= maxSize) {
    return [text];
  }
  
  const chunks = [];
  let start = 0;
  
  while (start < text.length) {
    let end = start + maxSize;
    
    // If we're not at the end, try to break at a sentence or paragraph
    if (end < text.length) {
      // Look for paragraph breaks first
      const lastParagraph = text.lastIndexOf('\n\n', end);
      if (lastParagraph > start + maxSize * 0.5) {
        end = lastParagraph + 2;
      } else {
        // Look for sentence endings
        const lastSentence = Math.max(
          text.lastIndexOf('. ', end),
          text.lastIndexOf('.\n', end),
          text.lastIndexOf('! ', end),
          text.lastIndexOf('?\n', end)
        );
        if (lastSentence > start + maxSize * 0.5) {
          end = lastSentence + 1;
        }
      }
    }
    
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  
  return chunks;
}

// Utility function for HTTP requests with timeout and retry
async function makeRequest(url, options, retryCount = 0) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.MAX_REQUEST_TIMEOUT);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (retryCount < CONFIG.RETRY_ATTEMPTS) {
      const delay = CONFIG.RETRY_DELAY * Math.pow(2, retryCount);
      console.log(`⚠️  Request failed, retrying in ${delay/1000}s... (attempt ${retryCount + 1}/${CONFIG.RETRY_ATTEMPTS})`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return makeRequest(url, options, retryCount + 1);
    }
    
    throw error;
  }
}

async function quickIngest() {
  console.log('🚀 Quick Direct Ingestion (File or Folder)...\n');
  
  // Get path from command line arguments
  const inputPath = process.argv[2];
  
  if (!inputPath) {
    console.log('❌ Please provide a file or folder path!');
    console.log('Usage: node quick-ingest.cjs <path>');
    console.log('Examples:');
    console.log('  node quick-ingest.cjs "./documents"');
    console.log('  node quick-ingest.cjs "C:\\Users\\Documents\\file.txt"');
    return;
  }
  
  console.log(`📂 Processing path: ${inputPath}`);
  
  // Check if path exists
  if (!fs.existsSync(inputPath)) {
    console.log('❌ Path does not exist:', inputPath);
    return;
  }
  
  // Check if it's a file or folder
  const stats = fs.statSync(inputPath);
  let filesToProcess = [];
  
  if (stats.isFile()) {
    console.log('📄 Processing single file');
    filesToProcess = [{
      fullPath: inputPath,
      filename: path.basename(inputPath),
      folder: path.dirname(inputPath)
    }];
  } else if (stats.isDirectory()) {
    console.log('📁 Processing folder');
    
    // Read all files from folder
    let files;
    try {
      files = fs.readdirSync(inputPath);
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
      console.log('💡 Convert PDFs to text first or modify supportedExtensions in the script');
      return;
    }
    
    filesToProcess = supportedFiles.map(file => ({
      fullPath: path.join(inputPath, file),
      filename: file,
      folder: inputPath
    }));
  }
  
  // Process files
  let totalContent = '';
  let fileContents = [];
  
  for (const fileInfo of filesToProcess) {
    console.log(`\n📖 Reading: ${fileInfo.filename}`);
    
    try {
      const content = fs.readFileSync(fileInfo.fullPath, 'utf8');
      console.log(`  ✅ Read ${content.length} characters`);
      
      fileContents.push({
        filename: fileInfo.filename,
        content: content,
        size: content.length
      });
      
      // Add file separator for multiple files
      if (filesToProcess.length > 1) {
        totalContent += `\n\n=== ${fileInfo.filename} ===\n\n${content}`;
      } else {
        totalContent = content; // Single file, no separator needed
      }
      
    } catch (error) {
      console.log(`  ❌ Failed to read ${fileInfo.filename}:`, error.message);
    }
  }
  
  console.log(`\n📊 Total content: ${totalContent.length} characters from ${fileContents.length} files`);
  
  // Create base document info
  const baseName = stats.isFile() ? path.parse(inputPath).name : path.basename(inputPath);
  const timestamp = Date.now();
  
  // Create short ID to avoid 64-byte limit
  let shortId;
  if (baseName.length > 30) {
    // Truncate long names and add hash for uniqueness
    const hash = Buffer.from(baseName).toString('base64').slice(0, 8);
    shortId = `${baseName.slice(0, 20)}-${hash}-${timestamp.toString().slice(-6)}`;
  } else {
    shortId = `${baseName}-${timestamp.toString().slice(-8)}`;
  }
  
  console.log(`🔧 Generated short ID (${shortId.length} bytes): ${shortId}`);
  
  const documentTitle = stats.isFile() ? fileContents[0].filename : `Documents from ${baseName}`;
  const documentSource = stats.isFile() ? `File: ${inputPath}` : `Folder: ${inputPath} (${fileContents.length} files)`;
  
  console.log('\n📤 Preparing to send to public ingest endpoint...');
  console.log(`🆔 Document ID: ${shortId}`);
  console.log(`📝 Title: ${documentTitle}`);
  console.log(`📂 Source: ${documentSource}`);
  console.log(`📏 Total size: ${Math.round(totalContent.length / 1024)} KB`);
  
  // Check if document needs chunking
  const needsChunking = totalContent.length > CONFIG.MAX_CHUNK_SIZE;
  
  if (needsChunking) {
    console.log(`⚡ Large document detected! Breaking into chunks (max ${Math.round(CONFIG.MAX_CHUNK_SIZE/1000)}KB each)...`);
    const chunks = chunkText(totalContent, CONFIG.MAX_CHUNK_SIZE);
    console.log(`📦 Created ${chunks.length} chunks`);
    
    const startTime = Date.now();
    let totalChunksCreated = 0;
    let totalVectorsStored = 0;
    
    // Process chunks sequentially to avoid overwhelming the server
    for (let i = 0; i < chunks.length; i++) {
      const chunkId = `${shortId}-chunk-${i + 1}`;
      const chunkTitle = `${documentTitle} (Part ${i + 1}/${chunks.length})`;
      
      console.log(`\n⏳ Sending chunk ${i + 1}/${chunks.length} (${Math.round(chunks[i].length/1024)} KB)...`);
      
      const payload = {
        id: chunkId,
        text: chunks[i],
        title: chunkTitle,
        source: `${documentSource} - Part ${i + 1}/${chunks.length}`
      };
      
      try {
        const response = await makeRequest('https://bt-rag.hybridrag.workers.dev/ingest-public', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          console.log(`❌ HTTP Error for chunk ${i + 1}:`, response.status, response.statusText);
          const errorText = await response.text();
          console.log('Error details:', errorText);
          continue; // Skip this chunk but continue with others
        }

        const result = await response.json();
        console.log(`✅ Chunk ${i + 1}/${chunks.length} processed successfully`);
        
        if (result.chunks !== undefined) {
          totalChunksCreated += result.chunks;
        }
        if (result.upserted !== undefined) {
          totalVectorsStored += result.upserted;
        }
        
        // Small delay between chunks to be nice to the server
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
      } catch (error) {
        console.log(`❌ Network error for chunk ${i + 1}:`, error.message);
        console.log('⚠️  Continuing with remaining chunks...');
      }
    }
    
    const duration = Date.now() - startTime;
    console.log('\n🎉 SUCCESS! Large document ingested successfully!');
    console.log(`⏱️  Total time: ${Math.round(duration/1000)} seconds`);
    console.log(`📦 Document chunks: ${chunks.length}`);
    console.log(`📊 Processing results:`);
    console.log(`  📄 Total chunks created: ${totalChunksCreated}`);
    console.log(`  💾 Total vectors stored: ${totalVectorsStored}`);
    
  } else {
    // Single document processing (existing logic)
    const payload = {
      id: shortId,
      text: totalContent,
      title: documentTitle,
      source: documentSource
    };
    
    const startTime = Date.now();
    console.log('\n⏳ Sending to ingestion endpoint...');
    
    try {
      const response = await makeRequest('https://bt-rag.hybridrag.workers.dev/ingest-public', {
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
      
    } catch (error) {
      console.log('\n❌ Network/Connection error:', error.message);
      console.log('💡 Make sure your internet connection is working and the endpoint is accessible');
      return;
    }
  }
  
  // Common success output
  console.log('\n📋 File breakdown:');
  fileContents.forEach(file => {
    console.log(`  - ${file.filename}: ${Math.round(file.size/1024)} KB`);
  });
  
  console.log('\n✨ Your documents are now searchable in the RAG system!');
  console.log(`🔍 Test with queries about: ${fileContents.map(f => path.parse(f.filename).name).join(', ')}`);
}

quickIngest();