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
    // Render clickable citations with type - handle both bracket formats
    let rendered = line.replace(/[\[\【](#\d+|W\d+)[\]\】]/g, (m, ref) => {
      let type = ref.startsWith('#') ? 'ingested' : 'web';
      let label = type === 'ingested' ? 'Ingested' : 'Web';
      console.log('Creating citation link:', { match: m, ref: ref, type: type, label: label });
      return `<span class=\"citation-link\" data-citation=\"${ref}\" data-type=\"${type}\" title=\"${label} citation\" style=\"color: #0ea5e9; cursor: pointer; text-decoration: underline dotted;\">${m}<span class=\"citation-type\">[${label}]</span></span>`;
    });
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
        <div class="content-text">${displayContent.replace(/\n/g, '<br>')}</div>
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

  try {
    const res = await fetch(`${getEndpoint()}/chat`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    // Try to detect if this is a streaming (SSE) response
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
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
          assistantBubble.classList.remove('streaming');
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
      const data = await readJsonOrText(res);
      if (!res.ok) throw new Error(data.error || 'Error');
      if (data.answer) assistantBubble.textContent = data.answer;
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

async function ingestSelected() {
  const input = document.getElementById('ingestFiles');
  const log = document.getElementById('log');
  const files = Array.from(input.files || []);
  if (!files.length) {
    log.textContent = 'No files selected.';
    return;
  }
  log.textContent = `Ingesting ${files.length} files...\n`;

  for (const f of files) {
    try {
      const text = await extractTextFromFile(f);
      const id = f.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
      const body = { id, text, title: f.name, source: f.name };
      const res = await fetch(`${getEndpoint()}/ingest`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, ...getAuthHeaders() },
        body: JSON.stringify(body)
      });
      const data = await readJsonOrText(res);
      if (!res.ok) throw new Error(data.error || 'Error');
      log.textContent += `OK: ${f.name} (chunks=${data.chunks})\n`;
    } catch (err) {
      log.textContent += `FAIL: ${f.name} → ${String(err.message || err)}\n`;
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
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
});