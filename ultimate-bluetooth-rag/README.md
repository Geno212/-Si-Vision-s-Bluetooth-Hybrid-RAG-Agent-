# Ultimate Bluetooth RAG Agent (Cloudflare Workers)

An end-to-end Retrieval-Augmented Generation (RAG) agent optimized for Bluetooth technical documents. It runs entirely on Cloudflare’s free services with generous daily quotas.

## Architecture & Approach

- Compute: Cloudflare Workers
- Embeddings: Workers AI `@cf/baai/bge-large-en-v1.5` (1024‑dim)
- Retrieval: Cloudflare Vectorize (cosine ANN)
- Re-ranking: Workers AI `@cf/baai/bge-reranker-base`
- Storage: Cloudflare R2 (stores original text)
- Static UI: Served via Workers assets

### Retrieval pipeline
1. Chunk on ingest (heading-aware, 1200 chars, 200 overlap). Store chunks in Vectorize with rich metadata.
2. Multi-query retrieval at query time:
   - Generate up to 2 paraphrases of the question
   - Embed all queries in parallel; query Vectorize in parallel
   - Merge with Reciprocal Rank Fusion (RRF) and de-duplicate by `id`
3. Re-rank with cross-encoder; enforce diversity:
   - Per-document cap (default 2)
   - Ensure at least 2 distinct sources when available
4. Synthesize with strict grounding:
   - Per-sentence citations [#n]/[Wn]
   - Quote exact technical names verbatim when present
   - If insufficient context, state what’s missing

### Why this scales
- Multi-query + RRF raises recall without exploding latency.
- Diversity constraints prevent single‑doc dominance.
- Strict grounding avoids hallucinations and keeps answers auditable.

## Cost & Quotas (as of 2025)
- Workers & Workers AI: free tier included by Cloudflare; model calls within generous daily limits
- Vectorize: free tier with large daily vector read/write quotas
- R2: free tier with substantial egress; we store only text
- Net effect: end-to-end usage is free for typical daily workloads

## Quick start

1) Install deps
```
npm install
```

2) Provision Cloudflare resources (names match `wrangler.toml`)
```
npx wrangler@latest vectorize create bt-rag-index --dimension 1024 --metric cosine
npx wrangler@latest r2 bucket create bt-rag-docs
```

3) Configure variables/secrets
```
# local dev in .dev.vars (already present in this repo)
API_AUTH_TOKEN=your-dev-token

# production secrets
npx wrangler@latest secret put API_AUTH_TOKEN
# (SERPER/TAVILY optional; web fallback is disabled by design)
```

4) Develop locally
```
npm run dev
```

5) Deploy
```
npm run deploy
```

## Ingest
Local folder `./docs` with `.txt`, `.md`, `.pdf`, `.docx`, `.tex`:
```
$env:API_AUTH_TOKEN="yourtoken"; npx tsx scripts/extract_and_ingest.ts https://YOUR_WORKER_URL ./docs
```
Plain text only:
```
$env:API_AUTH_TOKEN="yourtoken"; npx tsx scripts/ingest_dir.ts https://YOUR_WORKER_URL ./docs
```

## Query
```
curl -s -X POST \
  -H "content-type: application/json" \
  -H "authorization: Bearer YOUR_TOKEN" \
  -d '{"query":"What is the ATT MTU and how does it affect throughput?"}' \
  https://YOUR_WORKER_URL/query | jq
```

## Test from any device (mobile included)
Share your deployed Worker URL (e.g., `https://bt-rag.hybridrag.workers.dev`). The UI is fully responsive and works on mobile.

## Configuration
- `wrangler.toml` sets models and knobs (`TOP_K`, `TOP_RERANK`, etc.)
- `src/index.ts` implements multi-query + RRF fusion and context diversity
- `src/retrieval.ts` contains embedding/rerank/synthesis logic and model shape handling

## Observability
Tail logs to see retrieval steps:
```
npx wrangler@latest tail
# Look for: RAG_QUERY_START, RAG_EMBED, RAG_VECTORIZE, RAG_ANSWER
```

## Security
- Use `API_AUTH_TOKEN` for auth; set in `.dev.vars` (dev) and as a secret (prod)
- For stricter control, front with Cloudflare Access

## Notes
- Web fallback is intentionally not used; quality comes from your corpus
- All services used are free-tier friendly; no additional paid setup required