## Relevant Files

- `ultimate-bluetooth-rag/src/index.ts` - Add `POST /chat` endpoint with SSE; route for memory clear/export; keep `/query`.
- `ultimate-bluetooth-rag/src/retrieval.ts` - Support conversational synthesis input (rolling summary + last N turns) while preserving citations.
- `ultimate-bluetooth-rag/src/types.ts` - Define chat message types, conversation and memory types; extend `Env` with KV/DO bindings.
- `ultimate-bluetooth-rag/src/memory.ts` (new) - Conversation state (append, load, summarize, clear); rolling summary logic.
- `ultimate-bluetooth-rag/src/do.chat.ts` (new, optional v1) - Durable Object for ordered chat state (if enabled).
- `ultimate-bluetooth-rag/wrangler.toml` - Add KV namespace `BT_RAG_CHAT_KV`; optional DO class binding; optional memory Vectorize index.
- `ultimate-bluetooth-rag/public/index.html` - Replace single Q&A panel with chat timeline + conversation list and actions.
- `ultimate-bluetooth-rag/public/assets/main.js` - Chat client: SSE handling, message timeline, citations, conversation mgmt.
- `ultimate-bluetooth-rag/public/assets/styles.css` - Styles for chat bubbles, conversation list, streaming state.
- `ultimate-bluetooth-rag/README.md` - Update usage: provisioning KV/DO, new endpoints, UI instructions.

### Notes

- For local testing of Workers, consider `wrangler dev` and `wrangler tail` for logs. If adding tests, Miniflare can emulate Workers APIs.
- Keep strict grounding: do not let memory replace RAG citations; memory summaries must be separate prompt context.

## Tasks

- [ ] 1.0 Backend: Introduce chat API with streaming
  - [x] 1.1 Extend `Env` and types in `src/types.ts`: `ChatMessage`, `ChatRequestBody`, `ChatResponse`, plus KV/DO bindings.
  - [ ] 1.2 Add streaming helpers in `src/index.ts` (ReadableStream + writer); JSON fallback if streaming unsupported.
  - [x] 1.2 Add streaming helpers in `src/index.ts` (ReadableStream + writer); JSON fallback if streaming unsupported.
  - [ ] 1.3 Implement `POST /chat`: parse body, create/resolve `conversationId`, load memory (summary + last N), compose prompts.
  - [x] 1.3 Implement `POST /chat`: parse body, create/resolve `conversationId`, load memory (summary + last N), compose prompts.
  - [ ] 1.4 Reuse retrieval pipeline: embed latest user turn, expand queries, vectorize, rerank, pick context.
  - [x] 1.4 Reuse retrieval pipeline: embed latest user turn, expand queries, vectorize, rerank, pick context.
  - [ ] 1.5 Synthesize conversational response with citations; stream tokens when `stream=true`, else return JSON.
  - [x] 1.5 Synthesize conversational response with citations; stream tokens when `stream=true`, else return JSON.
  - [x] 1.6 Persist assistant message to memory; return `{ conversationId, answer, citations }`.
  - [x] 1.7 Keep `/query` unchanged and working; allow single-turn usage to bootstrap a conversation internally.
  
  

- [ ] 2.0 Memory layer: Short-term window + rolling summary (KV; optional DO)
  - [ ] 2.1 Add `BT_RAG_CHAT_KV` binding in `wrangler.toml`; update `Env` typing.
  - [x] 2.2 Create `src/memory.ts` with: `getConversation`, `appendMessage`, `updateSummaryIfNeeded`, `clearConversation`, `exportConversation`.
  - [x] 2.3 Implement rolling summary via Workers AI with configurable thresholds (e.g., after 10 turns or >4KB state).
  - [x] 2.4 Apply TTL retention (default 30 days) and per-access refresh; support pinning to disable TTL.
  - [ ] 2.5 Optional ordering: scaffold `src/do.chat.ts` Durable Object for serialized updates; guard behind feature flag.
  - [x] 2.6 Expose memory routes in `src/index.ts`: `DELETE /memory/:conversationId`, `GET /memory/:conversationId`.

- [ ] 3.0 UI: Chat timeline, streaming, citations, conversation management
  - [x] 3.1 Update `public/index.html` to include: conversation list, chat timeline, input box, actions (Clear, Export, Rename); keep Ingest panel.
  - [x] 3.2 Implement client logic in `public/assets/main.js`:
    - [x] 3.2.1 Create/load conversations; manage `conversationId` across page reloads.
    - [x] 3.2.2 Send user messages to `/chat` with `stream=true`; read stream via `ReadableStream`.
    - [x] 3.2.3 Incrementally render assistant tokens and final citations under the last assistant message.
    - [x] 3.2.4 Implement Clear/Rename/Export actions and state updates.
  - [x] 3.3 Extend `public/assets/styles.css` for bubbles (user vs assistant), conversation list, streaming indicator.
  - [x] 3.4 Regression: ensure ingest workflow remains functional and visible.

- [ ] 4.0 Config & infra: KV/DO bindings, optional memory vector index, env typing
  - [x] 4.1 Update `wrangler.toml`: add `[kv_namespaces]` `BT_RAG_CHAT_KV`, optional `[durable_objects]` class for `ChatSessionDO`.
  - [x] 4.2 Add config vars: `CHAT_TURN_WINDOW`, `CHAT_TTL_DAYS`; document defaults in README.
  - [ ] 4.3 Optional long-term memory: provision `VECTORIZE_MEMORY_INDEX` (if enabled later); extend types and no-op when absent.
  - [x] 4.4 Update `.dev.vars` example and production secret steps for any new vars.

- [ ] 5.0 Security & identity: Anonymous session cookie, auth gating, privacy controls
  - [x] 5.1 Keep `API_AUTH_TOKEN` gating for `/ingest`, `/chat`, and memory routes (allow unset in dev).
  - [x] 5.2 Implement anonymous `userId` cookie (HTTP-only) and associate conversations with `userId` when present.
  - [x] 5.3 Provide Clear Memory UX and endpoints; document data retention and scope (conv-level vs user-level).

- [ ] 6.0 Bluetooth enhancements v1: Device registry, GATT notes, tool-calling stubs
  - [ ] 6.1 Extend memory schema with `DeviceRegistry` (`deviceId`, `nickname`, `notes`, `lastSeen`).
  - [ ] 6.2 Add `GATTNotes` per device (services/characteristics discussed) and merge into rolling summary when device context is active.
  - [ ] 6.3 Define tool-calling stubs/types in `src/types.ts` and placeholder handler in `src/index.ts` (no real device I/O in Workers).

- [ ] 7.0 Observability & docs: CHAT_* logs, README updates, migration notes
  - [x] 7.1 Add structured logs in `src/index.ts`: `CHAT_START`, `CHAT_EMBED`, `CHAT_VECTORIZE`, `CHAT_SUMMARY_UPDATE`, `CHAT_ANSWER` with timing.
  - [x] 7.2 Update `README.md` with provisioning for KV/DO, new endpoints, streaming usage, and `wrangler tail` examples.
  - [x] 7.3 Provide manual test scripts: cURL for `/chat` (non-stream), example fetch-based streaming snippet, memory export/clear.
  - [ ] 7.4 Capture baseline performance metrics and a correctness sampling checklist.


