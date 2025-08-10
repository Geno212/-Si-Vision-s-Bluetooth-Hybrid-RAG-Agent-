export interface Chunk {
  content: string;
  offset: number;
  length: number;
}

export interface ChunkerOptions {
  maxChars?: number;       // per chunk target size
  overlapChars?: number;   // sliding overlap
}

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_OVERLAP_CHARS = 200;

function splitByHeadings(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] = [];

  const pushCurrent = () => {
    if (current.length > 0) {
      blocks.push(current.join("\n"));
      current = [];
    }
  };

  for (const line of lines) {
    if (/^\s*(#{1,6}\s+|[-=]{3,}\s*$|\d+\.\s+|[A-Z][A-Za-z0-9\s]{0,60}:\s*$)/.test(line)) {
      pushCurrent();
      current.push(line);
    } else {
      current.push(line);
    }
  }
  pushCurrent();
  return blocks.filter(b => b.trim().length > 0);
}

export function chunkText(text: string, options: ChunkerOptions = {}): Chunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const overlap = options.overlapChars ?? DEFAULT_OVERLAP_CHARS;

  const sections = splitByHeadings(text);
  const chunks: Chunk[] = [];

  let globalOffset = 0; // we will recompute offsets per push

  for (const section of sections) {
    const s = section.trim();
    if (s.length === 0) continue;

    if (s.length <= maxChars) {
      chunks.push({ content: s, offset: globalOffset, length: s.length });
      globalOffset += s.length + 1;
      continue;
    }

    // Sliding window for long sections
    let start = 0;
    while (start < s.length) {
      const end = Math.min(start + maxChars, s.length);
      const slice = s.slice(start, end);
      chunks.push({ content: slice, offset: globalOffset + start, length: slice.length });
      if (end === s.length) break;
      start = end - overlap;
      if (start < 0) start = 0;
    }
    globalOffset += s.length + 1;
  }

  return chunks;
} 