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

async function ask() {
  const q = document.getElementById('question').value.trim();
  const answerEl = document.getElementById('answer');
  const citationsEl = document.getElementById('citations');
  answerEl.textContent = '...';
  citationsEl.innerHTML = '';

  try {
    const res = await fetch(`${getEndpoint()}/query`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...getAuthHeaders() },
      body: JSON.stringify({ query: q })
    });
    const data = await readJsonOrText(res);
    if (!res.ok) throw new Error(data.error || 'Error');
    answerEl.textContent = data.answer || '';
    if (Array.isArray(data.citations)) {
      const frag = document.createDocumentFragment();
      for (const c of data.citations) {
        const div = document.createElement('div');
        div.className = 'citation';
        div.textContent = `${c.ref} ${c.title || c.id} ${c.source ? ' - ' + c.source : ''}`;
        frag.appendChild(div);
      }
      citationsEl.appendChild(frag);
    }
  } catch (err) {
    answerEl.textContent = String(err.message || err);
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
  document.getElementById('ask').addEventListener('click', ask);
  document.getElementById('ingestBtn').addEventListener('click', ingestSelected);
}); 