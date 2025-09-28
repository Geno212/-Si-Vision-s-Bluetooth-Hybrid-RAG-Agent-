// RAG Resource Deletion Script
// Usage: node delete-resources.cjs <type> [options]

const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

async function deleteResources() {
  console.log('🗑️  RAG Resource Deletion Tool\n');
  
  const type = process.argv[2];
  const endpoint = 'https://bt-rag.hybridrag.workers.dev';
  
  if (!type) {
    console.log('Usage: node delete-resources.cjs <type> [document_id]');
    console.log('Types:');
    console.log('  document <id>    - Delete specific document and all its chunks');
    console.log('  conversation <id> - Delete specific conversation');
    console.log('  list-docs        - List all documents in the system');
    console.log('  list-convos      - List all conversations');
    console.log('  cleanup-all      - Delete ALL documents (dangerous!)');
    rl.close();
    return;
  }
  
  try {
    switch (type) {
      case 'document':
        await deleteDocument(endpoint);
        break;
      case 'conversation':
        await deleteConversation(endpoint);
        break;
      case 'list-docs':
        await listDocuments(endpoint);
        break;
      case 'list-convos':
        await listConversations(endpoint);
        break;
      case 'cleanup-all':
        await cleanupAll(endpoint);
        break;
      default:
        console.log('❌ Unknown type:', type);
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
  
  rl.close();
}

async function deleteDocument(endpoint) {
  const docId = process.argv[3];
  
  if (!docId) {
    console.log('❌ Please provide document ID');
    console.log('Usage: node delete-resources.cjs document <document_id>');
    console.log('💡 Use "list-docs" to see available documents');
    return;
  }
  
  console.log(`🔍 Checking document: ${docId}`);
  
  // First check if document exists
  const statsResponse = await fetch(`${endpoint}/debug/document-stats?doc_id=${docId}`);
  if (!statsResponse.ok) {
    console.log('❌ Document not found or stats unavailable');
    return;
  }
  
  const stats = await statsResponse.json();
  console.log(`📊 Document found: ${stats.chunk_count} chunks, ${stats.total_size} KB`);
  
  const confirm = await ask(`⚠️  Really delete "${docId}" and ALL its ${stats.chunk_count} chunks? (yes/no): `);
  
  if (confirm.toLowerCase() !== 'yes') {
    console.log('🚫 Deletion cancelled');
    return;
  }
  
  console.log('🗑️  Deleting document...');
  
  const response = await fetch(`${endpoint}/admin/delete-document`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer local-dev-token-123' // Use your API token
    },
    body: JSON.stringify({ doc_id: docId })
  });
  
  if (response.ok) {
    const result = await response.json();
    console.log(`✅ Successfully deleted ${result.deleted_chunks} chunks`);
  } else {
    console.log('❌ Deletion failed:', await response.text());
  }
}

async function deleteConversation(endpoint) {
  const convoId = process.argv[3];
  
  if (!convoId) {
    console.log('❌ Please provide conversation ID');
    return;
  }
  
  console.log(`🗑️  Deleting conversation: ${convoId}`);
  
  const response = await fetch(`${endpoint}/memory/${convoId}`, {
    method: 'DELETE'
  });
  
  if (response.ok) {
    console.log('✅ Conversation deleted successfully');
  } else {
    console.log('❌ Deletion failed:', await response.text());
  }
}

async function listDocuments(endpoint) {
  console.log('📋 Fetching document list...');
  
  const response = await fetch(`${endpoint}/debug/list-documents`);
  if (!response.ok) {
    console.log('❌ Could not fetch document list');
    return;
  }
  
  const docs = await response.json();
  
  console.log(`📄 Found ${docs.length} documents:\n`);
  docs.forEach((doc, i) => {
    console.log(`${i + 1}. ID: ${doc.doc_id}`);
    console.log(`   Title: ${doc.title || 'N/A'}`);
    console.log(`   Chunks: ${doc.chunk_count}`);
    console.log(`   Size: ${Math.round(doc.total_size / 1024)} KB`);
    console.log('');
  });
}

async function listConversations(endpoint) {
  console.log('💬 Note: Conversations are auto-generated UUIDs');
  console.log('   Check your browser localStorage or recent chat URLs');
  console.log('   Format: https://your-domain.com/?conversationId=<uuid>');
}

async function cleanupAll(endpoint) {
  console.log('⚠️  DANGER: This will delete ALL documents and vectors!');
  const confirm1 = await ask('Type "DELETE ALL" to confirm: ');
  
  if (confirm1 !== 'DELETE ALL') {
    console.log('🚫 Cancelled');
    return;
  }
  
  const confirm2 = await ask('This is IRREVERSIBLE. Type "I UNDERSTAND" to proceed: ');
  
  if (confirm2 !== 'I UNDERSTAND') {
    console.log('🚫 Cancelled');
    return;
  }
  
  console.log('🗑️  Deleting ALL documents...');
  
  const response = await fetch(`${endpoint}/admin/cleanup-all`, {
    method: 'DELETE',
    headers: {
      'Authorization': 'Bearer local-dev-token-123'
    }
  });
  
  if (response.ok) {
    const result = await response.json();
    console.log(`✅ Cleanup complete: ${result.deleted_vectors} vectors deleted`);
  } else {
    console.log('❌ Cleanup failed:', await response.text());
  }
}

deleteResources();



