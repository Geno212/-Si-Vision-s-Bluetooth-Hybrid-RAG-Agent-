function getEndpoint() {
  const v = document.getElementById('endpoint').value.trim();
  if (!v) return location.origin;
  return v.replace(/\/$/, '');
}

function getAuthHeaders() {
  const token = document.getElementById('token').value.trim();
  return token ? { 'authorization': `Bearer ${token}` } : {};
}

const JSON_HEADERS = { 'content-type': 'application/json', 'accept': 'application/json' };

async function readJsonOrText(res) {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json')) {
    try { return await res.json(); } catch { /* fallthrough */ }
  }
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: text || 'Unknown error' }; }
}

// ---- Chat UI logic ----

function getSelect(id) { return document.getElementById(id); }
function getEl(id) { return document.getElementById(id); }

function loadConversationsFromLocalStorage() {
  try {
    const raw = localStorage.getItem('bt_rag_conversations') || '[]';
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function saveConversationsToLocalStorage(list) {
  try { localStorage.setItem('bt_rag_conversations', JSON.stringify(list)); } catch {}
}

function upsertConversationList(conversationId, name) {
  const list = loadConversationsFromLocalStorage();
  const idx = list.findIndex(x => x.id === conversationId);
  if (idx >= 0) {
    if (name) list[idx].name = name;
  } else {
    list.unshift({ id: conversationId, name: name || `Conversation ${new Date().toLocaleString()}` });
  }
  saveConversationsToLocalStorage(list);
  renderConversationSelect();
}

function renderConversationSelect() {
  const sel = getSelect('conversations');
  const list = loadConversationsFromLocalStorage();
  sel.innerHTML = '';
  for (const item of list) {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = item.name || item.id;
    sel.appendChild(opt);
  }
  const current = sessionStorage.getItem('bt_rag_current_conversation') || '';
  if (current) sel.value = current;
}

function setCurrentConversationId(id) {
  if (id) sessionStorage.setItem('bt_rag_current_conversation', id);
  else sessionStorage.removeItem('bt_rag_current_conversation');
  renderConversationSelect();
}

function getCurrentConversationId() {
  return sessionStorage.getItem('bt_rag_current_conversation') || '';
}

function appendMessage(role, text, streaming=false) {
  const chat = getEl('chat');
  const row = document.createElement('div');
  row.className = `msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  // If assistant, render answer with citation highlighting and clickable citations
  if (role === 'assistant' && text) {
    renderAssistantAnswer(bubble, text);
  } else {
    bubble.textContent = text || '';
  }
  if (streaming) bubble.classList.add('streaming');
  row.appendChild(bubble);
  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;
  return bubble;
}

// Highlight uncited/malformed steps, clickable citations, and inline validation notes
function renderAssistantAnswer(container, answerText) {
  console.log('renderAssistantAnswer called with:', answerText);
  
  // Split out [Validation Notes] if present
  let [main, ...rest] = answerText.split(/\n\n\[Validation Notes\]\n/);
  let validationNotes = rest.length ? rest.join('\n\n[Validation Notes]\n').split(/\n- /).filter(Boolean) : [];
  // Split main answer into lines/steps
  const lines = main.split(/\n/);
  container.innerHTML = '';
  lines.forEach((line, idx) => {
    if (!line.trim()) return;
    // Detect citation at end - handle both square brackets [#1] and Chinese brackets 【#1】
    const citationMatch = line.match(/[\[\【](#\d+|W\d+)[\]\】]$/);
    let stepDiv = document.createElement('div');
    stepDiv.className = 'answer-step';
    // Highlight uncited or malformed steps
    if (/step|procedure|first|second|finally|conclusion|summary/i.test(line)) {
      if (!citationMatch) {
        stepDiv.classList.add('uncited-step');
      } else {
        // Check for malformed: citation not at end or multiple citations
        const allMatches = [...line.matchAll(/[\[\【](#\d+|W\d+)[\]\】]/g)];
        if (allMatches.length > 1 || (allMatches.length === 1 && !line.trim().match(/[\[\【](#\d+|W\d+)[\]\】]$/))) {
          stepDiv.classList.add('malformed-citation');
        }
      }
    }
    // First, render clickable citations with type - handle both bracket formats
    let rendered = line.replace(/[\[\【](#\d+|W\d+)[\]\】]/g, (m, ref) => {
      let type = ref.startsWith('#') ? 'ingested' : 'web';
      let label = type === 'ingested' ? 'Ingested' : 'Web';
      console.log('Creating citation link:', { match: m, ref: ref, type: type, label: label });
      return `<span class=\"citation-link\" data-citation=\"${ref}\" data-type=\"${type}\" title=\"${label} citation\" style=\"color: #0ea5e9; cursor: pointer; text-decoration: underline dotted;\">${m}<span class=\"citation-type\">[${label}]</span></span>`;
    });
    
    // Then apply markdown-style formatting for better readability
    console.log('Before formatting:', rendered);
    rendered = applyMarkdownFormatting(rendered);
    console.log('After formatting:', rendered);
    stepDiv.innerHTML = rendered;
    container.appendChild(stepDiv);
  });
  // Inline validation notes (if any)
  if (validationNotes.length) {
    let notesDiv = document.createElement('div');
    notesDiv.className = 'validation-notes-panel';
    notesDiv.innerHTML = `<b>Validation Notes:</b><ul>` + validationNotes.map(n => `<li>${n}</li>`).join('') + `</ul>`;
    container.appendChild(notesDiv);
  }
  // Robust event delegation for citation clicks
  if (!container._citationHandlerAttached) {
    container.addEventListener('click', function(e) {
      console.log('Container clicked:', e.target);
      const target = e.target.closest('.citation-link');
      console.log('Citation link target:', target);
      if (target) {
        const ref = target.getAttribute('data-citation');
        const type = target.getAttribute('data-type');
        console.log('Citation clicked:', { ref, type });
        showCitationContext(ref, type);
        e.preventDefault();
        e.stopPropagation();
      }
    });
    container._citationHandlerAttached = true;
    console.log('Citation handler attached to container:', container);
  }
}

// Apply markdown-style formatting to text for better visual presentation
function applyMarkdownFormatting(text) {
  console.log('applyMarkdownFormatting input:', text);
  
  // First, parse and convert any tables using our lightweight parser
  let processedText = text;
  
  // Check if the text contains table-like content and parse it
  if (processedText.includes('|') && processedText.split('\n').some(line => line.trim().includes('|'))) {
    console.log('Table-like content detected, parsing...');
    processedText = parseMarkdownTables(processedText);
  }
  
  const result = processedText
    // Bold text: **text** -> <strong>text</strong>
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong style="color: var(--accent); font-weight: 600;">$1</strong>')
    // Italic text: *text* -> <em>text</em> (but avoid interfering with bold)
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em style="color: var(--accent-2); font-style: italic;">$1</em>')
    // Code inline: `code` -> <code>code</code>
    .replace(/`([^`\n]+)`/g, '<code style="background: rgba(14, 165, 233, 0.1); color: var(--accent-2); padding: 2px 4px; border-radius: 3px; font-family: monospace; border: 1px solid rgba(14, 165, 233, 0.2);">$1</code>')
    // Headers: ### Text -> <h3>Text</h3>
    .replace(/^###\s+(.+)$/gm, '<h3 style="color: var(--accent); font-size: 1.1em; font-weight: bold; margin: 0.8em 0 0.4em 0;">$1</h3>')
    .replace(/^##\s+(.+)$/gm, '<h2 style="color: var(--accent); font-size: 1.2em; font-weight: bold; margin: 0.8em 0 0.4em 0;">$1</h2>')
    .replace(/^#\s+(.+)$/gm, '<h1 style="color: var(--accent); font-size: 1.3em; font-weight: bold; margin: 0.8em 0 0.4em 0;">$1</h1>')
    // Numbered lists: 1. Item -> proper list
    .replace(/^\d+\.\s+(.+)$/gm, '<div style="margin: 0.3em 0; padding-left: 1.2em;">• $1</div>')
    // Blockquotes: > Text -> styled blockquote
    .replace(/^>\s+(.+)$/gm, '<blockquote style="border-left: 3px solid var(--accent); padding-left: 1em; margin: 0.5em 0; font-style: italic; color: var(--accent-2);">$1</blockquote>')
    // Horizontal rules: --- -> <hr>
    .replace(/^---+$/gm, '<hr style="border: none; border-top: 1px solid rgba(255,255,255,0.2); margin: 1em 0;">')
    // Line breaks for better spacing (preserve double breaks for paragraphs)
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>');
  
  console.log('applyMarkdownFormatting output:', result);
  return result;
}

// Initialize lightweight table parser
let tableParser = null;

// Initialize table parser when available
function initTableParser() {
  if (typeof LightweightTableParser !== 'undefined' && !tableParser) {
    tableParser = new LightweightTableParser({
      trimWhitespace: true,
      skipEmptyLines: true,
      headerRow: true,
      maxRows: 1000 // Limit for performance
    });
    console.log('✅ Lightweight table parser initialized successfully');
  } else if (typeof LightweightTableParser === 'undefined') {
    console.warn('❌ LightweightTableParser not found - table parsing will use fallback');
  } else if (tableParser) {
    console.log('✅ Table parser already initialized');
  }
}

// Enhanced table parser with fallback
function parseTableContent(text, format = 'auto') {
  // Initialize parser if not already done
  initTableParser();
  
  if (!tableParser) {
    console.warn('Table parser not available, using fallback');
    return simpleTableParserFallback(text);
  }
  
  try {
    let tableData;
    
    switch (format) {
      case 'csv':
        tableData = tableParser.parseCSV(text);
        break;
      case 'markdown':
        tableData = tableParser.parseMarkdown(text);
        break;
      case 'html':
        tableData = tableParser.parseHTML(text);
        break;
      default:
        tableData = tableParser.parseAuto(text);
    }
    
    if (tableData.length > 0) {
      // Use our custom HTML generation with enhanced cell processing
      return generateEnhancedTableHTML(tableData);
    }
    
    return simpleTableParserFallback(text);
  } catch (error) {
    console.warn('Table parsing failed, using fallback:', error);
    return simpleTableParserFallback(text);
  }
}

// Generate enhanced table HTML with proper cell processing
function generateEnhancedTableHTML(tableData) {
  if (!Array.isArray(tableData) || tableData.length === 0) return '';
  
  let html = '<table class="lightweight-table" style="border-collapse: collapse; margin: 1em 0; width: 100%; background: rgba(255, 255, 255, 0.05); border-radius: 4px;">';
  
  tableData.forEach((row, rowIndex) => {
    if (!Array.isArray(row)) return;
    
    const isHeader = rowIndex === 0;
    const cellTag = isHeader ? 'th' : 'td';
    const cellStyle = isHeader 
      ? 'padding: 8px 12px; border: 1px solid rgba(14, 165, 233, 0.3); background: rgba(14, 165, 233, 0.1); font-weight: bold; color: var(--accent);'
      : 'padding: 6px 12px; border: 1px solid rgba(255, 255, 255, 0.2); vertical-align: top;';
    
    html += '<tr>';
    row.forEach(cell => {
      const formattedCell = processCellContent(cell || '');
      html += `<${cellTag} style="${cellStyle}">${formattedCell}</${cellTag}>`;
    });
    html += '</tr>';
  });
  
  html += '</table>';
  
  // Attach citation handlers after a short delay
  setTimeout(() => {
    attachCitationHandlersToTables();
  }, 50);
  
  return html;
}

// Fallback simple table parser
function simpleTableParserFallback(text) {
  // Convert simple table rows to basic HTML
  return text.replace(/^\|(.+)\|$/gm, (match, content) => {
    // Skip separator rows
    if (content.includes('---')) return '';
    
    const cells = content.split('|').map(cell => cell.trim());
    const cellHtml = cells.map(cell => `<td style="padding: 8px; border: 1px solid rgba(255,255,255,0.2);">${cell}</td>`).join('');
    return `<tr style="background: rgba(255,255,255,0.05);">${cellHtml}</tr>`;
  });
}

// Enhanced table parser for complex markdown tables with lightweight parser integration
function parseMarkdownTables(text) {
  console.log('parseMarkdownTables input:', text.substring(0, 300) + '...');
  
  // Try the lightweight parser first
  const enhancedResult = parseTableContent(text, 'markdown');
  if (enhancedResult && enhancedResult.includes('<table')) {
    console.log('Using lightweight parser result');
    return enhancedResult;
  }
  
  // Fallback to existing logic for complex cases
  const lines = text.split('\n');
  let result = [];
  let inTable = false;
  let tableRows = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();
    
    // More robust table detection - must have at least 2 pipes and not be empty
    const isPipeRow = trimmedLine.includes('|') && trimmedLine.split('|').length >= 3 && trimmedLine.length > 2;
    const isSeparatorRow = trimmedLine.match(/^\|[\s\-|:]+\|$/);
    
    if (isPipeRow || isSeparatorRow) {
      if (!inTable) {
        inTable = true;
        tableRows = [];
        console.log('Starting table at line:', i, trimmedLine);
      }
      tableRows.push(trimmedLine);
    } else if (inTable) {
      // End of table, process accumulated rows
      console.log('Ending table, rows collected:', tableRows.length);
      if (tableRows.length > 0) {
        const tableHtml = renderMarkdownTableOptimized(tableRows);
        result.push(tableHtml);
        tableRows = [];
      }
      inTable = false;
      result.push(line);
    } else {
      result.push(line);
    }
  }
  
  // Handle table at end of text
  if (inTable && tableRows.length > 0) {
    console.log('Ending table at end, rows collected:', tableRows.length);
    result.push(renderMarkdownTableOptimized(tableRows));
  }
  
  console.log('parseMarkdownTables output:', result.join('\n').substring(0, 300) + '...');
  return result.join('\n');
}

// Optimized table renderer using lightweight parser when available
function renderMarkdownTableOptimized(rows) {
  console.log('renderMarkdownTableOptimized called with rows:', rows);
  if (rows.length === 0) return '';
  
  // Try using lightweight parser for better performance
  const markdownText = rows.join('\n');
  const enhancedResult = parseTableContent(markdownText, 'markdown');
  if (enhancedResult && enhancedResult.includes('<table')) {
    return enhancedResult;
  }
  
  // Fallback to existing renderer
  return renderMarkdownTable(rows);
}

// Render a complete markdown table to HTML
function renderMarkdownTable(rows) {
  console.log('renderMarkdownTable called with rows:', rows);
  if (rows.length === 0) return '';
  
  // Filter out separator rows and empty rows
  const dataRows = rows.filter(row => {
    const trimmed = row.trim();
    return trimmed.length > 0 && !trimmed.match(/^\|[\s\-|:]+\|$/);
  });
  
  console.log('Filtered data rows:', dataRows);
  
  if (dataRows.length === 0) return '';
  
  let html = '<table class="lightweight-table" style="border-collapse: collapse; margin: 1em 0; width: 100%; background: rgba(255, 255, 255, 0.05); border-radius: 4px;">';
  
  dataRows.forEach((row, index) => {
    const cells = row.split('|').map(cell => cell.trim()).filter(cell => cell !== '');
    console.log(`Row ${index} cells:`, cells);
    
    if (cells.length === 0) return;
    
    const isHeader = index === 0;
    const cellTag = isHeader ? 'th' : 'td';
    const cellStyle = isHeader 
      ? 'padding: 8px 12px; border: 1px solid rgba(14, 165, 233, 0.3); background: rgba(14, 165, 233, 0.1); font-weight: bold; color: var(--accent);'
      : 'padding: 6px 12px; border: 1px solid rgba(255, 255, 255, 0.2); vertical-align: top;';
    
    html += '<tr>';
    cells.forEach(cell => {
      // Process cell content through enhanced formatting pipeline
      let formattedCell = processCellContent(cell);
      
      html += `<${cellTag} style="${cellStyle}">${formattedCell}</${cellTag}>`;
    });
    html += '</tr>';
  });
  
  html += '</table>';
  console.log('Generated table HTML:', html.substring(0, 200) + '...');
  
  // Set a short timeout to attach citation handlers after DOM is updated
  setTimeout(() => {
    attachCitationHandlersToTables();
  }, 50);
  
  return html;
}

// Process individual cell content with proper formatting
function processCellContent(cellText) {
  if (!cellText || typeof cellText !== 'string') return '';
  
  let processed = cellText
    // Handle line breaks first
    .replace(/\n/g, '<br>')
    .replace(/<br>\s*<br>/g, '<br>')  // Avoid double breaks
    
    // Bold text: **text** -> <strong>text</strong>
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong style="color: var(--accent); font-weight: 600;">$1</strong>')
    
    // Italic text: *text* -> <em>text</em> (but avoid interfering with bold)
    .replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '<em style="color: var(--accent-2); font-style: italic;">$1</em>')
    
    // Code inline: `code` -> <code>code</code>
    .replace(/`([^`\n]+?)`/g, '<code style="background: rgba(14, 165, 233, 0.1); color: var(--accent-2); padding: 2px 4px; border-radius: 3px; font-family: monospace; border: 1px solid rgba(14, 165, 233, 0.2);">$1</code>')
    
    // Citation links: [#123], [1], [7] -> clickable links
    .replace(/\[([#]?\d+)\]/g, '<span class="citation-link table-citation" data-citation="$1" data-type="ingested" title="Click to view citation" style="color: var(--accent); cursor: pointer; text-decoration: underline; font-weight: 500;">[$1]</span>')
    
    // Handle text that looks like it could be sources/references
    .replace(/\b(source|ref|reference):\s*([^<\n]+)/gi, '<span style="color: var(--accent-2); font-style: italic;">$1:</span> <span style="color: var(--accent);">$2</span>')
    
    // URLs: handle basic URL detection  
    .replace(/(https?:\/\/[^\s<>"{}|\\^`\[\]]+)/g, '<a href="$1" target="_blank" style="color: var(--accent); text-decoration: underline;">$1</a>');
  
  return processed;
}

// Attach citation handlers specifically to table citations
function attachCitationHandlersToTables() {
  // Find all table citation links that don't have handlers
  const tableCitations = document.querySelectorAll('.table-citation:not([data-handler-attached])');
  
  tableCitations.forEach(link => {
    link.addEventListener('click', function(e) {
      const ref = this.getAttribute('data-citation');
      const type = this.getAttribute('data-type') || 'ingested';
      console.log('Table citation clicked:', ref, type);
      showCitationContext(ref, type);
      e.preventDefault();
      e.stopPropagation();
    });
    
    // Mark as having handler attached
    link.setAttribute('data-handler-attached', 'true');
  });
  
  console.log(`Attached citation handlers to ${tableCitations.length} table citations`);
}

// Show citation context or web snippet in a modal/panel
function showCitationContext(ref, type) {
  // Try to find citation in the last citations panel
  const citations = window.lastCitations || [];
  console.log('Available citations:', citations);
  console.log('Looking for ref:', ref);
  const c = citations.find(x => x.ref === ref || x.id === ref);
  console.log('Found citation:', c);
  let html = '';
  if (c) {
    let label = (ref.startsWith('#')) ? 'Ingested' : 'Web';
    const content = c.content || c.text || 'Content not available';
    // Truncate very long content for better display
    const displayContent = content.length > 2000 ? content.substring(0, 2000) + '...' : content;
    html = `
      <div class="citation-header">
        <h4>${c.title || c.id}</h4>
        <p class="citation-source"><strong>Source:</strong> ${c.source || 'Unknown'}</p>
        <p class="citation-id"><strong>ID:</strong> <code>${c.id}</code></p>
        <span class="citation-label">${label} citation</span>
      </div>
      <div class="citation-content">
        <h5>Referenced Content:</h5>
        <div class="content-text" style="line-height: 1.6; text-align: justify;">${applyMarkdownFormatting(displayContent)}</div>
      </div>
    `;
  } else {
    let label = (ref.startsWith('#')) ? 'Ingested' : 'Web';
    html = `
      <div class="citation-header">
        <h4>Citation ${ref}</h4>
        <p>Citation not found in context.</p>
        <span class="citation-label">${label} citation</span>
      </div>
    `;
  }
  showModal('Citation Reference', html);
}

// Simple modal implementation
function showModal(title, html) {
  let modal = document.getElementById('modal-panel');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-panel';
    modal.className = 'modal-panel';
    modal.innerHTML = `<div class="modal-content"><span class="modal-close">&times;</span><h3></h3><div class="modal-body"></div></div>`;
    document.body.appendChild(modal);
  }
  
  // Always re-attach event handlers to ensure they work
  const closeBtn = modal.querySelector('.modal-close');
  closeBtn.onclick = () => { 
    console.log('Close button clicked');
    modal.style.display = 'none'; 
  };
  modal.onclick = (e) => { 
    if (e.target === modal) {
      console.log('Modal background clicked');
      modal.style.display = 'none'; 
    }
  };
  
  modal.querySelector('h3').innerHTML = title;
  modal.querySelector('.modal-body').innerHTML = html;
  modal.style.display = 'block';
  console.log('Modal displayed');
}

function clearChat() {
  getEl('chat').innerHTML = '';
  getEl('citations').innerHTML = '';
}

async function loadConversation(conversationId) {
  clearChat();
  if (!conversationId) return;
  try {
    const res = await fetch(`${getEndpoint()}/memory/${conversationId}`, { headers: { ...getAuthHeaders() } });
    const data = await readJsonOrText(res);
    if (!res.ok) throw new Error(data.error || 'Error');
    const conv = data.conversation || {};
    const turns = Array.isArray(conv.turns) ? conv.turns : [];
    for (const t of turns) appendMessage(t.role === 'assistant' ? 'assistant' : 'user', String(t.content || ''));
  } catch (err) {
    appendMessage('assistant', `Failed to load conversation: ${String(err.message || err)}`);
  }
}

function renderCitations(citations) {
  const el = getEl('citations');
  el.innerHTML = '';
  if (!Array.isArray(citations)) return;
  window.lastCitations = citations;
  const frag = document.createDocumentFragment();
  for (const c of citations) {
    let type = c.ref.startsWith('#') ? 'ingested' : 'web';
    let label = type === 'ingested' ? 'Ingested' : 'Web';
    const div = document.createElement('div');
    div.className = 'citation';
    div.innerHTML = `<span class="citation-link" data-citation="${c.ref}" data-type="${type}" title="${label} citation">${c.ref}<span class="citation-type">[${label}]</span></span> ${c.title || c.id} ${c.source ? ' - ' + c.source : ''}`;
    frag.appendChild(div);
  }
  el.appendChild(frag);
  // Robust event delegation for sidebar citations
  if (!el._citationHandlerAttached) {
    el.addEventListener('click', function(e) {
      const target = e.target.closest('.citation-link');
      if (target) {
        const ref = target.getAttribute('data-citation');
        const type = target.getAttribute('data-type');
        showCitationContext(ref, type);
        e.preventDefault();
        e.stopPropagation();
      }
    });
    el._citationHandlerAttached = true;
  }
}

async function sendChat() {
  const input = getEl('chatInput');
  const content = input.value.trim();
  if (!content) return;
  input.value = '';
  const userBubble = appendMessage('user', content);
  const assistantBubble = appendMessage('assistant', '', true);
  const citationsEl = getEl('citations');
  citationsEl.innerHTML = '';

  let conversationId = getCurrentConversationId();
  const maxIter = Number(getEl('maxIterInput')?.value) || 2;
  const body = { conversationId: conversationId || undefined, messages: [{ role: 'user', content }], stream: true, maxIter };

  // Store the user question for feedback context
  let responseMetadata = null;

  try {
    const res = await fetch(`${getEndpoint()}/chat`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    // Try to detect if this is a streaming (SSE) response
    const contentType = res.headers.get('content-type') || '';
    console.log('Response content-type:', contentType);
    if (contentType.includes('text/event-stream')) {
      console.log('Processing as streaming SSE response');
      // Parse SSE stream
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = 'message';
      let currentData = '';
      const flushEvent = () => {
        if (currentEvent === 'meta') {
          try { const meta = JSON.parse(currentData || '{}'); if (meta.conversationId) {
            conversationId = meta.conversationId; setCurrentConversationId(conversationId); upsertConversationList(conversationId);
          }} catch {}
        } else if (currentEvent === 'citations') {
          try { const obj = JSON.parse(currentData || '{}'); renderCitations(obj.citations || []); } catch {}
        } else if (currentEvent === 'error') {
          appendMessage('assistant', `\n[Error] ${currentData}`);
        } else if (currentEvent === 'end') {
          console.log('Stream end event received!');
          assistantBubble.classList.remove('streaming');
          // Apply formatting to the final complete text
          const finalText = assistantBubble.textContent || '';
          console.log('Streaming ended, applying formatting to final text:', finalText.substring(0, 200) + '...');
          if (finalText.trim()) {
            console.log('About to apply renderAssistantAnswer formatting...');
            assistantBubble.innerHTML = ''; // Clear previous content
            renderAssistantAnswer(assistantBubble, finalText);
            console.log('Formatting applied!');
            
            // Add feedback buttons for non-verified answers
            if (responseMetadata && !responseMetadata.verified) {
              addFeedbackButtons(assistantBubble, { question: content, metadata: responseMetadata });
            }
          } else {
            console.log('No text to format (empty finalText)');
          }
        } else {
          assistantBubble.textContent += currentData;
        }
        currentEvent = 'message'; currentData = '';
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const d = line.slice(6);
            if (currentData) currentData += '\n';
            currentData += d;
          } else if (line.trim() === '') {
            // dispatch
            if (currentData) flushEvent();
          }
        }
      }
      if (currentData) flushEvent();
    } else {
      // Non-streaming: parse as JSON and display
      console.log('Processing as non-streaming JSON response');
      const data = await readJsonOrText(res);
      if (!res.ok) throw new Error(data.error || 'Error');
      
      // Extract metadata if available
      responseMetadata = data.metadata || null;
      
      if (data.answer) {
        console.log('Non-streaming answer received, applying formatting...');
        assistantBubble.innerHTML = ''; // Clear previous content
        
        // Add verified badge if it's a correction cache hit
        if (responseMetadata?.verified) {
          addVerifiedBadge(assistantBubble, responseMetadata);
        }
        
        renderAssistantAnswer(assistantBubble, data.answer);
        
        // Add feedback buttons for non-verified answers
        if (!responseMetadata?.verified) {
          addFeedbackButtons(assistantBubble, { question: content, metadata: responseMetadata });
        }
      }
      if (data.citations) renderCitations(data.citations);
      assistantBubble.classList.remove('streaming');
      if (data.conversationId) {
        conversationId = data.conversationId;
        setCurrentConversationId(conversationId);
        upsertConversationList(conversationId);
      }
    }
  } catch (err) {
    assistantBubble.classList.remove('streaming');
    assistantBubble.textContent = `Error: ${String(err.message || err)}`;
  }
}

async function newConversation() {
  setCurrentConversationId('');
  clearChat();
}

async function clearConversation() {
  const id = getCurrentConversationId();
  if (!id) { clearChat(); return; }
  try {
    const res = await fetch(`${getEndpoint()}/memory/${id}`, { method: 'DELETE', headers: { ...getAuthHeaders() } });
    await res.text();
  } catch {}
  // remove from local list
  const list = loadConversationsFromLocalStorage().filter(x => x.id !== id);
  saveConversationsToLocalStorage(list);
  setCurrentConversationId('');
  clearChat();
}

async function exportConversation() {
  const id = getCurrentConversationId();
  if (!id) return;
  try {
    const res = await fetch(`${getEndpoint()}/memory/${id}`, { headers: { ...getAuthHeaders() } });
    const data = await readJsonOrText(res);
    if (!res.ok) throw new Error(data.error || 'Error');
    const blob = new Blob([JSON.stringify(data.conversation || {}, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${id}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (err) {
    appendMessage('assistant', `Export failed: ${String(err.message || err)}`);
  }
}

function extOf(name) {
  const m = /\.([^.]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

async function extractPdfText(file) {
  const arrayBuffer = await file.arrayBuffer();
  const lib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
  if (!lib) throw new Error('PDF.js not loaded');
  if (lib.GlobalWorkerOptions) {
    lib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  }
  const doc = await lib.getDocument({ data: arrayBuffer }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map((it) => it.str).filter(Boolean);
    text += strings.join(' ') + '\n\n';
  }
  return text.trim();
}

async function extractDocxText(file) {
  const ab = await file.arrayBuffer();
  const mammoth = window.mammoth;
  if (!mammoth) throw new Error('Mammoth not loaded');
  const { value } = await mammoth.extractRawText({ arrayBuffer: ab });
  return String(value || '').trim();
}

async function extractTextFromFile(file) {
  const e = extOf(file.name);
  if (e === 'txt' || e === 'md' || e === 'tex') {
    return await file.text();
  }
  if (e === 'pdf') return await extractPdfText(file);
  if (e === 'docx') return await extractDocxText(file);
  throw new Error(`Unsupported file type: .${e}`);
}

// Configuration for large document handling
const INGEST_CONFIG = {
  MAX_CHUNK_SIZE: 300000, // 300KB per chunk (characters)
  MAX_REQUEST_TIMEOUT: 60000, // 60 seconds
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 2000 // 2 seconds base delay
};

// Utility function to chunk large text
function chunkLargeText(text, maxSize) {
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
async function makeIngestRequest(url, options, retryCount = 0) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), INGEST_CONFIG.MAX_REQUEST_TIMEOUT);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (retryCount < INGEST_CONFIG.RETRY_ATTEMPTS && error.name !== 'AbortError') {
      const delay = INGEST_CONFIG.RETRY_DELAY * Math.pow(2, retryCount);
      console.log(`Request failed, retrying in ${delay/1000}s... (attempt ${retryCount + 1}/${INGEST_CONFIG.RETRY_ATTEMPTS})`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return makeIngestRequest(url, options, retryCount + 1);
    }
    
    throw error;
  }
}

async function ingestSelected() {
  const input = document.getElementById('ingestFiles');
  const log = document.getElementById('log');
  const files = Array.from(input.files || []);
  if (!files.length) {
    log.textContent = 'No files selected.';
    return;
  }
  
  log.textContent = `🚀 Quick Direct Ingestion - Processing ${files.length} file(s)...\n\n`;

  for (const f of files) {
    const startTime = Date.now();
    
    try {
      log.textContent += `📄 Processing: ${f.name} (${Math.round(f.size / 1024)} KB)\n`;
      
      // Read file content
      const text = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsText(f);
      });
      
      log.textContent += `  ✅ Read ${text.length} characters\n`;
      
      // Create document ID
      const timestamp = Date.now();
      const baseName = f.name.replace(/\.[^/.]+$/, ''); // Remove extension
      let shortId;
      if (baseName.length > 30) {
        // Truncate long names and add hash for uniqueness
        const hash = btoa(baseName).slice(0, 8);
        shortId = `${baseName.slice(0, 20)}-${hash}-${timestamp.toString().slice(-6)}`;
      } else {
        shortId = `${baseName}-${timestamp.toString().slice(-8)}`;
      }
      
      const documentTitle = f.name;
      const documentSource = `Browser Upload: ${f.name}`;
      
      log.textContent += `  🆔 Document ID: ${shortId}\n`;
      log.textContent += `  📏 Size: ${Math.round(text.length / 1024)} KB\n`;
      
      // Check if document needs chunking
      const needsChunking = text.length > INGEST_CONFIG.MAX_CHUNK_SIZE;
      
      if (needsChunking) {
        log.textContent += `  ⚡ Large document detected! Breaking into chunks (max ${Math.round(INGEST_CONFIG.MAX_CHUNK_SIZE/1000)}KB each)...\n`;
        const chunks = chunkLargeText(text, INGEST_CONFIG.MAX_CHUNK_SIZE);
        log.textContent += `  📦 Created ${chunks.length} chunks\n`;
        
        let totalChunksCreated = 0;
        let totalVectorsStored = 0;
        
        // Process chunks sequentially
        for (let i = 0; i < chunks.length; i++) {
          const chunkId = `${shortId}-chunk-${i + 1}`;
          const chunkTitle = `${documentTitle} (Part ${i + 1}/${chunks.length})`;
          
          log.textContent += `  ⏳ Sending chunk ${i + 1}/${chunks.length} (${Math.round(chunks[i].length/1024)} KB)...\n`;
          
          const payload = {
            id: chunkId,
            text: chunks[i],
            title: chunkTitle,
            source: `${documentSource} - Part ${i + 1}/${chunks.length}`
          };
          
          try {
            const response = await makeIngestRequest(`${getEndpoint()}/ingest-public`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });

            if (!response.ok) {
              const errorText = await response.text();
              log.textContent += `  ❌ HTTP Error for chunk ${i + 1}: ${response.status} ${response.statusText}\n`;
              log.textContent += `     ${errorText}\n`;
              continue;
            }

            const result = await response.json();
            log.textContent += `  ✅ Chunk ${i + 1}/${chunks.length} processed successfully\n`;
            
            if (result.chunks !== undefined) totalChunksCreated += result.chunks;
            if (result.upserted !== undefined) totalVectorsStored += result.upserted;
            
            // Small delay between chunks
            if (i < chunks.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
          } catch (error) {
            log.textContent += `  ❌ Network error for chunk ${i + 1}: ${error.message}\n`;
            log.textContent += `     Continuing with remaining chunks...\n`;
          }
        }
        
        const duration = Math.round((Date.now() - startTime) / 1000);
        log.textContent += `\n🎉 SUCCESS! ${f.name} ingested in ${duration}s\n`;
        log.textContent += `📊 Processing results:\n`;
        log.textContent += `  📦 Document chunks: ${chunks.length}\n`;
        log.textContent += `  📄 Total chunks created: ${totalChunksCreated}\n`;
        log.textContent += `  💾 Total vectors stored: ${totalVectorsStored}\n\n`;
        
      } else {
        // Single document processing
        const payload = {
          id: shortId,
          text: text,
          title: documentTitle,
          source: documentSource
        };
        
        log.textContent += `  ⏳ Sending to ingestion endpoint...\n`;
        
        try {
          const response = await makeIngestRequest(`${getEndpoint()}/ingest-public`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          const duration = Math.round((Date.now() - startTime) / 1000);
          
          if (!response.ok) {
            const errorText = await response.text();
            log.textContent += `  ❌ HTTP Error: ${response.status} ${response.statusText}\n`;
            log.textContent += `     ${errorText}\n\n`;
            continue;
          }

          const result = await response.json();
          
          log.textContent += `\n🎉 SUCCESS! ${f.name} ingested in ${duration}s\n`;
          log.textContent += `📊 Processing results:\n`;
          
          if (result.chunks !== undefined) {
            log.textContent += `  📄 Chunks created: ${result.chunks}\n`;
          }
          if (result.upserted !== undefined) {
            log.textContent += `  💾 Vectors stored: ${result.upserted}\n`;
          }
          log.textContent += '\n';
          
        } catch (error) {
          log.textContent += `  ❌ Network error: ${error.message}\n`;
          log.textContent += `     Make sure your internet connection is working\n\n`;
          continue;
        }
      }
      
    } catch (err) {
      log.textContent += `❌ FAIL: ${f.name} → ${String(err.message || err)}\n\n`;
    }
  }
  
  log.textContent += `✨ All files processed! Documents are now searchable in the RAG system.\n`;
  
  // Clear file input
  input.value = '';
}

// Sidebar toggle functionality
function initSidebar() {
  const sidebar = document.getElementById('sidebar');
  const sidebarToggle = document.getElementById('sidebarToggle');
  const sidebarClose = document.getElementById('sidebarClose');
  
  function openSidebar() {
    sidebar.classList.add('open');
  }
  
  function closeSidebar() {
    sidebar.classList.remove('open');
  }
  
  sidebarToggle.addEventListener('click', openSidebar);
  sidebarClose.addEventListener('click', closeSidebar);
  
  // Close sidebar when clicking outside
  document.addEventListener('click', (e) => {
    if (sidebar.classList.contains('open') && 
        !sidebar.contains(e.target) && 
        !sidebarToggle.contains(e.target)) {
      closeSidebar();
    }
  });
  
  // Close sidebar on ESC key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sidebar.classList.contains('open')) {
      closeSidebar();
    }
  });
}

// ---- Document Management ----

async function listDocuments() {
  const log = document.getElementById('log');
  const documentsList = document.getElementById('documentsList');
  const documentsSelect = document.getElementById('documentsSelect');
  
  try {
    log.textContent += 'Fetching document list...\n';
    
    const res = await fetch(`${getEndpoint()}/debug/list-documents`, {
      headers: { ...getAuthHeaders() }
    });
    
    const docs = await readJsonOrText(res);
    if (!res.ok) throw new Error(docs.error || 'Failed to fetch documents');
    
    documentsSelect.innerHTML = '';
    
    if (docs.length === 0) {
      log.textContent += 'No documents found in the system.\n';
      const opt = document.createElement('option');
      opt.textContent = 'No documents available';
      opt.disabled = true;
      documentsSelect.appendChild(opt);
    } else {
      log.textContent += `Found ${docs.length} documents:\n`;
      
      docs.forEach((doc, i) => {
        const opt = document.createElement('option');
        opt.value = doc.doc_id;
        // Truncate long doc IDs for better display
        const displayId = doc.doc_id.length > 40 ? doc.doc_id.substring(0, 40) + '...' : doc.doc_id;
        const displayTitle = doc.title && doc.title !== doc.doc_id ? doc.title : displayId;
        opt.textContent = `${displayTitle} (${doc.chunk_count} chunks, ${Math.round(doc.total_size / 1024)} KB)`;
        opt.title = doc.doc_id; // Show full ID in tooltip
        documentsSelect.appendChild(opt);
        
        log.textContent += `${i + 1}. ${doc.doc_id} - ${doc.chunk_count} chunks\n`;
      });
    }
    
    documentsList.style.display = 'block';
    
  } catch (error) {
    log.textContent += `Error: ${error.message}\n`;
  }
}

async function viewDocumentStats() {
  const documentsSelect = document.getElementById('documentsSelect');
  const docStats = document.getElementById('docStats');
  const docStatsContent = document.getElementById('docStatsContent');
  const log = document.getElementById('log');
  
  const selectedDocId = documentsSelect.value;
  if (!selectedDocId) {
    log.textContent += 'Please select a document first.\n';
    return;
  }
  
  try {
    log.textContent += `Fetching stats for: ${selectedDocId}\n`;
    
    const res = await fetch(`${getEndpoint()}/debug/document-stats?doc_id=${encodeURIComponent(selectedDocId)}`, {
      headers: { ...getAuthHeaders() }
    });
    
    const stats = await readJsonOrText(res);
    if (!res.ok) throw new Error(stats.error || 'Failed to fetch document stats');
    
    docStatsContent.innerHTML = `
      <p><strong>Document ID:</strong> ${stats.doc_id}</p>
      <p><strong>Title:</strong> ${stats.title || 'N/A'}</p>
      <p><strong>Source:</strong> ${stats.source || 'N/A'}</p>
      <p><strong>Chunks:</strong> ${stats.chunk_count}</p>
      <p><strong>Total Size:</strong> ${Math.round(stats.total_size / 1024)} KB</p>
    `;
    
    docStats.style.display = 'block';
    log.textContent += `Stats loaded for ${selectedDocId}\n`;
    
  } catch (error) {
    log.textContent += `Error: ${error.message}\n`;
  }
}

async function deleteDocument() {
  const documentsSelect = document.getElementById('documentsSelect');
  const log = document.getElementById('log');
  
  const selectedDocId = documentsSelect.value;
  if (!selectedDocId) {
    log.textContent += 'Please select a document to delete.\n';
    return;
  }
  
  const selectedText = documentsSelect.options[documentsSelect.selectedIndex].textContent;
  
  if (!confirm(`⚠️ Are you sure you want to delete this document?\n\n${selectedText}\n\nThis action cannot be undone!`)) {
    log.textContent += 'Deletion cancelled.\n';
    return;
  }
  
  try {
    log.textContent += `Deleting document: ${selectedDocId}\n`;
    
    const res = await fetch(`${getEndpoint()}/admin/delete-document`, {
      method: 'DELETE',
      headers: { ...getAuthHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ doc_id: selectedDocId })
    });
    
    const result = await readJsonOrText(res);
    if (!res.ok) throw new Error(result.error || 'Failed to delete document');
    
    log.textContent += `✅ Successfully deleted ${result.deleted_chunks} chunks from ${selectedDocId}\n`;
    
    // Refresh the document list
    await listDocuments();
    
    // Hide stats if they were showing the deleted doc
    document.getElementById('docStats').style.display = 'none';
    
  } catch (error) {
    log.textContent += `❌ Delete failed: ${error.message}\n`;
  }
}

async function cleanupAllDocuments() {
  const log = document.getElementById('log');
  
  if (!confirm('⚠️ DANGER: This will delete ALL documents and vectors!\n\nThis action is IRREVERSIBLE!\n\nType "DELETE ALL" in the next prompt to confirm.')) {
    log.textContent += 'Cleanup cancelled.\n';
    return;
  }
  
  const confirmation = prompt('Type "DELETE ALL" to confirm complete cleanup:');
  if (confirmation !== 'DELETE ALL') {
    log.textContent += 'Cleanup cancelled - incorrect confirmation.\n';
    return;
  }
  
  try {
    log.textContent += '🗑️ Starting complete cleanup...\n';
    
    const res = await fetch(`${getEndpoint()}/admin/cleanup-all`, {
      method: 'DELETE',
      headers: { ...getAuthHeaders() }
    });
    
    const result = await readJsonOrText(res);
    if (!res.ok) throw new Error(result.error || 'Failed to cleanup documents');
    
    log.textContent += `✅ Cleanup complete: ${result.deleted_vectors} vectors deleted\n`;
    
    // Clear the document list
    const documentsSelect = document.getElementById('documentsSelect');
    documentsSelect.innerHTML = '<option disabled>No documents available</option>';
    
    // Hide panels
    document.getElementById('documentsList').style.display = 'none';
    document.getElementById('docStats').style.display = 'none';
    
  } catch (error) {
    log.textContent += `❌ Cleanup failed: ${error.message}\n`;
  }
}

// ============================================================================
// Human-in-the-Loop Feedback Functions
// ============================================================================

let currentFeedbackContext = null;

function addFeedbackButtons(bubble, messageData) {
  // Don't add feedback buttons if already present or if it's a verified answer
  if (bubble.querySelector('.feedback-buttons') || messageData?.metadata?.verified) {
    return;
  }
  
  const feedbackDiv = document.createElement('div');
  feedbackDiv.className = 'feedback-buttons';
  
  const approveBtn = document.createElement('button');
  approveBtn.className = 'feedback-btn approve';
  approveBtn.innerHTML = '✅ This is correct';
  approveBtn.addEventListener('click', () => handleApprove(bubble, messageData));
  
  const correctBtn = document.createElement('button');
  correctBtn.className = 'feedback-btn correct';
  correctBtn.innerHTML = '❌ Incorrect - Let me fix it';
  correctBtn.addEventListener('click', () => handleCorrect(bubble, messageData));
  
  feedbackDiv.appendChild(approveBtn);
  feedbackDiv.appendChild(correctBtn);
  
  bubble.appendChild(feedbackDiv);
}

function handleApprove(bubble, messageData) {
  // Just remove feedback buttons - we only store corrections, not approvals
  const feedbackButtons = bubble.querySelector('.feedback-buttons');
  if (feedbackButtons) {
    feedbackButtons.remove();
  }
  
  // Optionally show a brief confirmation
  const confirmation = document.createElement('div');
  confirmation.style.cssText = 'margin-top: 8px; font-size: 12px; color: #10b981;';
  confirmation.textContent = '✓ Thank you for your feedback!';
  bubble.appendChild(confirmation);
  
  setTimeout(() => confirmation.remove(), 3000);
}

function handleCorrect(bubble, messageData) {
  // Store context for the correction modal
  currentFeedbackContext = {
    bubble: bubble,
    messageData: messageData,
    question: messageData?.question || 'Question not available',
    wrongAnswer: bubble.textContent.replace(/✅ This is correct❌ Incorrect - Let me fix it/g, '').trim(),
  };
  
  // Populate modal fields
  document.getElementById('correction-question').textContent = currentFeedbackContext.question;
  document.getElementById('correction-wrong-answer').textContent = currentFeedbackContext.wrongAnswer;
  document.getElementById('correction-correct-answer').value = '';
  
  // Clear variant inputs except first one
  const variantInputs = document.getElementById('variant-inputs');
  variantInputs.innerHTML = '<input type="text" class="variant-input" placeholder="E.g., \'How does BLE work?\'" />';
  
  // Show modal
  showCorrectionModal();
}

function showCorrectionModal() {
  const modal = document.getElementById('correction-modal');
  modal.style.display = 'flex';
  
  // Close button handler
  const closeBtn = modal.querySelector('.modal-close');
  closeBtn.onclick = () => {
    modal.style.display = 'none';
    currentFeedbackContext = null;
  };
  
  // Click outside to close
  modal.onclick = (e) => {
    if (e.target === modal) {
      modal.style.display = 'none';
      currentFeedbackContext = null;
    }
  };
}

function addVerifiedBadge(bubble, metadata) {
  if (!metadata?.verified) return;
  
  const badge = document.createElement('div');
  badge.className = 'verified-badge';
  
  const confidenceText = metadata.confidence 
    ? ` <span class="verified-confidence">(${(metadata.confidence * 100).toFixed(0)}% match)</span>`
    : '';
  
  badge.innerHTML = `
    <span class="verified-badge-icon">✓</span>
    <span>Verified Answer</span>
    ${confidenceText}
  `;
  
  // Insert at the beginning of the bubble
  bubble.insertBefore(badge, bubble.firstChild);
}

async function submitCorrection() {
  if (!currentFeedbackContext) {
    console.error('No feedback context available');
    return;
  }
  
  const correctAnswer = document.getElementById('correction-correct-answer').value.trim();
  
  if (!correctAnswer) {
    alert('Please provide the correct answer');
    return;
  }
  
  // Collect question variants
  const variantInputs = document.querySelectorAll('.variant-input');
  const questionVariants = Array.from(variantInputs)
    .map(input => input.value.trim())
    .filter(v => v.length > 0);
  
  const payload = {
    conversationId: getCurrentConversationId(),
    originalQuery: currentFeedbackContext.question,
    wrongAnswer: currentFeedbackContext.wrongAnswer,
    correctAnswer: correctAnswer,
    questionVariants: questionVariants.length > 0 ? questionVariants : undefined,
  };
  
  const submitBtn = document.getElementById('submit-correction-btn');
  const originalText = submitBtn.textContent;
  submitBtn.textContent = '💾 Saving...';
  submitBtn.disabled = true;
  
  try {
    const res = await fetch(`${getEndpoint()}/api/feedback/correct`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    const result = await readJsonOrText(res);
    
    if (!res.ok) {
      throw new Error(result.error || 'Failed to submit correction');
    }
    
    // Success! Hide modal and show confirmation
    document.getElementById('correction-modal').style.display = 'none';
    
    // Remove feedback buttons and show success message
    const feedbackButtons = currentFeedbackContext.bubble.querySelector('.feedback-buttons');
    if (feedbackButtons) {
      feedbackButtons.remove();
    }
    
    const confirmation = document.createElement('div');
    confirmation.style.cssText = 'margin-top: 8px; padding: 8px; background: #10b98111; border: 1px solid #10b98133; border-radius: 6px; font-size: 13px; color: #10b981;';
    confirmation.textContent = '✓ Correction saved! This answer will be used for similar questions in the future.';
    currentFeedbackContext.bubble.appendChild(confirmation);
    
    currentFeedbackContext = null;
    
    // Auto-remove confirmation after 5 seconds
    setTimeout(() => confirmation.remove(), 5000);
    
  } catch (error) {
    console.error('Failed to submit correction:', error);
    alert(`Failed to submit correction: ${error.message}`);
  } finally {
    submitBtn.textContent = originalText;
    submitBtn.disabled = false;
  }
}

// Initialize correction modal controls
function initCorrectionModal() {
  // Add variant button
  document.getElementById('add-variant-btn').addEventListener('click', () => {
    const variantInputs = document.getElementById('variant-inputs');
    const newInput = document.createElement('input');
    newInput.type = 'text';
    newInput.className = 'variant-input';
    newInput.placeholder = 'Alternative phrasing...';
    variantInputs.appendChild(newInput);
  });
  
  // Submit button
  document.getElementById('submit-correction-btn').addEventListener('click', submitCorrection);
  
  // Cancel button
  document.getElementById('cancel-correction-btn').addEventListener('click', () => {
    document.getElementById('correction-modal').style.display = 'none';
    currentFeedbackContext = null;
  });
}

window.addEventListener('DOMContentLoaded', () => {
  console.log('JavaScript loaded and DOM ready!');
  
  // Initialize table parser
  setTimeout(initTableParser, 100); // Give time for LightweightTableParser to load
  
  // Initialize sidebar
  initSidebar();
  
  // Initialize correction modal
  initCorrectionModal();
  
  // Initialize existing functionality
  renderConversationSelect();
  getSelect('conversations').addEventListener('change', (e) => {
    const id = e.target.value;
    setCurrentConversationId(id);
    loadConversation(id);
  });
  getEl('newConversation').addEventListener('click', newConversation);
  getEl('clearConversation').addEventListener('click', clearConversation);
  getEl('exportConversation').addEventListener('click', exportConversation);
  getEl('sendChat').addEventListener('click', sendChat);
  getEl('ingestBtn').addEventListener('click', ingestSelected);
  
  // Initialize document management
  getEl('listDocsBtn').addEventListener('click', listDocuments);
  getEl('refreshDocsBtn').addEventListener('click', listDocuments);
  getEl('viewDocBtn').addEventListener('click', viewDocumentStats);
  getEl('deleteDocBtn').addEventListener('click', deleteDocument);
  getEl('cleanupAllBtn').addEventListener('click', cleanupAllDocuments);
});