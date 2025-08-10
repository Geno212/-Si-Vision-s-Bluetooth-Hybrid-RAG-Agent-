// scripts/ingest_dir.ts
// Ingests only plain .txt/.md files without conversion.
// Usage:
//   $env:API_AUTH_TOKEN="yourtoken"; npx tsx scripts/ingest_dir.ts http://127.0.0.1:8787 ./plain_docs

import fs from 'node:fs/promises';
import path from 'node:path';

const endpoint = process.argv[2];
const dir = process.argv[3];
const token = process.env.API_AUTH_TOKEN || '';

if (!endpoint || !dir) {
  console.error('Usage: npx tsx scripts/ingest_dir.ts <endpoint> <folder>');
  process.exit(1);
}

async function walk(folder: string, root = folder) {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  const out: { id: string; text: string; title?: string; source?: string }[] = [];
  for (const e of entries) {
    const p = path.join(folder, e.name);
    if (e.isDirectory()) out.push(...await walk(p, root));
    else if (/\.(md|txt)$/i.test(e.name)) {
      const text = await fs.readFile(p, 'utf8');
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
  console.log(`Found ${files.length} text files. Ingesting...`);
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
  console.log('\nDone.');
})(); 