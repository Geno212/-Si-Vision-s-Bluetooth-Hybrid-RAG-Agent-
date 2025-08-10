// scripts/extract_and_ingest.ts
// Usage:
//   wrangler dev   # in another terminal (or deploy and use prod URL)
//   $env:API_AUTH_TOKEN="yourtoken"; npx tsx scripts/extract_and_ingest.ts http://127.0.0.1:8787 ./docs

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
// @ts-ignore
import mammoth from 'mammoth';
// @ts-ignore
import pdf from 'pdf-parse';

const endpoint = process.argv[2];
const dir = process.argv[3];
const token = process.env.API_AUTH_TOKEN || '';

if (!endpoint || !dir) {
  console.error('Usage: npx tsx scripts/extract_and_ingest.ts <endpoint> <folder>');
  process.exit(1);
}

async function toText(file: string): Promise<string> {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.txt' || ext === '.md' || ext === '.tex') return fs.readFile(file, 'utf8');
  if (ext === '.docx') {
    const buf = await fs.readFile(file);
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value;
  }
  if (ext === '.pdf') {
    const buf = await fs.readFile(file);
    const data = await pdf(buf);
    return data.text;
  }
  throw new Error(`Unsupported file type: ${ext} (use .txt/.md/.pdf/.docx/.tex)`);
}

async function walk(folder: string, root = folder) {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  const out: { id: string; text: string; title?: string; source?: string }[] = [];
  for (const e of entries) {
    const p = path.join(folder, e.name);
    if (e.isDirectory()) out.push(...await walk(p, root));
    else if (/\.(md|txt|pdf|docx|tex)$/i.test(e.name)) {
      const text = await toText(p);
      const id = path.relative(root, p)
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
      out.push({ id, text, title: path.basename(p), source: p });
    }
  }
  return out;
}

(async () => {
  const files = await walk(dir);
  console.log(`Found ${files.length} files. Extracting & ingesting...`);
  for (const f of files) {
    const res = await fetch(new URL('/ingest', endpoint).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
      body: JSON.stringify(f)
    });
    if (!res.ok) {
      console.error('Failed:', f.source, res.status, await res.text());
      process.exit(1);
    }
    process.stdout.write('.');
  }
  console.log('\nAll files ingested.');
})(); 