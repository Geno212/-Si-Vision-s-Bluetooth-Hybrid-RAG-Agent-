# PRD: Conversational Chat + Memory for Bluetooth Agent

## 1) Introduction / Overview

Today the agent answers one-off Bluetooth questions via a `POST /query` API and a simple web UI. This feature replaces the question–answer flow with a conversational chat experience that preserves context across turns and, optionally, across sessions. The chat will continue using the existing RAG pipeline (Vectorize + reranker + synthesis with citations) while adding a memory layer so the assistant can remember prior messages, user preferences, and device-specific context.

Primary goals:
- Upgrade from single-shot Q&A to multi-turn chat.
- Add short-term and optional long-term memory to improve coherence and reduce repeated questions.
- Keep strict, citation-first grounding from the existing pipeline.
- Introduce simple chat UI/controls and a streaming experience.
- Optionally enhance the Bluetooth agent with persistent device knowledge (nicknames, known GATT details, preferences) if applicable to the user’s workflows.

Assumption noted: The feature name is “Conversational Chat + Memory for Bluetooth Agent” (selected). Other choices defaulted below and called out as open questions.

## 2) Goals

1. Provide a `POST /chat` endpoint that handles multi-turn conversational input with memory.
2. Enable short-term, per-conversation memory (sliding window + rolling summaries) and optional long-term memory (per-user facts/preferences).
3. Preserve RAG behavior: per-sentence citations, diversity constraints, and the existing retrieval quality knobs.
4. Deliver a basic chat UI with message bubbles, streaming answers, citations panel, and memory controls (Clear, Export).
5. First token ≤ 3s P95 on typical queries (streaming), total answer ≤ 12s P95.
6. ≥ 90% of turns correctly reference prior context in manual evaluations.
7. Optional Bluetooth enhancements: persistent device registry, remembered nicknames, and GATT hints to improve responses.

## 3) User Stories

- As a firmware engineer, I want the assistant to remember my previous question so I don’t have to restate context every turn.
- As a QA tester, I want to save a conversation and return later so the assistant recalls device names and prior findings.
- As a support engineer, I want the assistant to use prior device-specific details (e.g., MTU we tested, services we inspected) when answering follow-ups.
- As a new user, I want to see sources for every claim so I can verify correctness.
- As a privacy-conscious user, I want to clear chat memory at any time.

## 4) Functional Requirements

1. Chat API
   1. Implement `POST /chat` accepting:
      - `conversationId` (string, optional; if absent, server creates one and returns it)
      - `messages`: array of `{ role: "system"|"user"|"assistant", content: string }`
      - `stream` (boolean, optional; default true)
      - `topK`, `topRerank` (optional overrides; default to env vars)
   2. Behavior:
      - Derive short-term context from the most recent turns plus a compact rolling summary of older turns.
      - Run the existing retrieval pipeline against the latest user message, optionally enriched with a memory summary.
      - Synthesize a conversational response with the same strict grounding and per-sentence citations.
      - Return streaming output (SSE) when `stream=true`; otherwise JSON with `answer` and `citations`.
   3. Back-compat: keep `POST /query` working; it may bootstrap a one-turn `conversationId` internally.

2. Memory (short-term)
   1. Maintain a sliding window of the last N messages (configurable; default 10–20 turns total).
   2. When the window exceeds N, generate or update a rolling summary of prior turns via Workers AI, retained alongside the conversation.
   3. Include the rolling summary in prompts for retrieval and synthesis, distinct from RAG document context.

3. Memory (long-term, optional v1)
   1. Persist facts and preferences across sessions keyed by `userId` (or anonymous cookie if no auth) and, optionally, `deviceId`.
   2. Store as structured records (KV) and, where retrieval-style recall is useful, also upsert summarized facts into a dedicated Vectorize index (e.g., `bt-rag-memory-index`).
   3. Provide memory controls via API:
      - `DELETE /memory/{conversationId}` to clear a conversation
      - `DELETE /memory/user` to clear user-level memory (with auth)
      - `GET /memory/{conversationId}` to export

4. Identity and sessions
   1. Default to anonymous sessions using an HTTP-only cookie; if present, honor `Authorization: Bearer` for authenticated users.
   2. Generate readable `conversationId` values suitable for the UI (e.g., timestamp-based short ids).

5. Chat UI
   1. Replace the single text area with a chat timeline (user/assistant bubbles), input box, and send button.
   2. Show streaming tokens in-place; maintain a side panel for citations and a list of past conversations.
   3. Provide actions: Clear conversation, Rename conversation, Export conversation (JSON).
   4. Maintain responsive design parity with the current UI.

6. Bluetooth agent enhancements (if applicable)
   1. Device registry memory (optional v1): persist known device nicknames and notes per user.
   2. GATT memory (optional v1): store previously discussed services/characteristics for known devices to improve follow-up answers.
   3. Event log ingestion (optional): allow uploading device logs/metrics and treat them as a first-class RAG source for that conversation.
   4. Tool-calling stubs: define a typed interface for future Bluetooth actions (scan/connect/read/write/notify) without implementing device I/O in Workers.

7. Security & privacy
   1. Respect existing `API_AUTH_TOKEN` gate for write APIs.
   2. Allow user-level Clear Memory. Default retention 30 days (configurable) for long-term memory. Short-term conversation state persists for 14 days unless pinned.
   3. Do not store credentials or secrets inside memory records.

## 5) Non-Goals (Out of Scope for this PRD)

- Voice input/output.
- Native mobile apps.
- Real Bluetooth device control from the Cloudflare Worker (not feasible in the Workers runtime). We only design stubs and memory for future integration with a device-side agent.
- Multi-tenant admin console.

## 6) Design Considerations (Optional)

- Conversational style must still show citations inline and avoid ungrounded claims.
- Memory summary content is separated from RAG documents in prompts to avoid conflating “user history” with “sources.”
- UI should remain lightweight and zero-dependency beyond what’s already included.

## 7) Technical Considerations (Optional)

Proposed components and changes (implementation will be scheduled via tasks):

1. Server-side
   - Add `POST /chat` to `src/index.ts` with SSE streaming. Reuse existing env vars (`TOP_K`, `TOP_RERANK`, `MODEL_*`).
   - Create `src/memory.ts`:
     - `getConversationState(conversationId)`, `appendMessage(...)`, `summarizeIfNeeded(...)`, `clearConversation(...)`.
     - Short-term state held in Durable Objects for ordering and rate control; persisted to KV for durability.
   - Add optional long-term memory:
     - KV namespace `BT_RAG_CHAT_KV` for JSON state (conversations, summaries, device notes).
     - Separate Vectorize index `bt-rag-memory-index` for summarized long-term facts (optional).
   - Update `wrangler.toml`:
     - `[kv_namespaces]` binding `BT_RAG_CHAT_KV`.
     - `[durable_objects]` and class `ChatSessionDO` with script `src/do.chat.ts` (optional v1).
   - Prompting:
     - System prompt updated to conversational persona; preserve grounding and citations.
     - Compose messages = [system, rollingSummary?, last N turns, latest user].

2. UI (`public/`)
   - Replace the “Ask” panel with a chat timeline and input area.
   - Add conversation list (left column or dropdown), rename, clear, and export.
   - Use `EventSource` (SSE) for streaming when `stream=true`.
   - Continue to render citations beneath each assistant message.

3. Data models
   - `Conversation`: `{ id, userId?, createdAt, updatedAt, title, summary?, turns: MessageRef[] }`
   - `Message`: `{ id, role, content, createdAt, tokens? }`
   - `MemoryFact` (optional): `{ id, userId, deviceId?, text, vector? }`

4. Observability
   - Log markers: `CHAT_START`, `CHAT_EMBED`, `CHAT_VECTORIZE`, `CHAT_SUMMARY_UPDATE`, `CHAT_ANSWER`.
   - Tail via `wrangler tail` as today.

5. Migration
   - Keep `/query` for backward compatibility.
   - UI defaults to the new chat but provides a “single question” quick action backed by `/query`.

Risks/mitigations:
- Streaming support depends on model API behavior. If streaming is unavailable, fall back to chunked flushing or non-streaming responses.
- Durable Objects introduce stateful complexity; can start with KV-only state and add DO later for ordering.

## 8) Success Metrics

- ≥ 90% of turns correctly reference necessary prior context (manual evaluation on test scripts).
- Re-ask rate reduced by ≥ 30% compared to Q&A baseline.
- First token latency ≤ 3s P95 with streaming; full answer ≤ 12s P95.
- RAG citation density unchanged (≥ 1 citation per factual sentence on sampled audits).
- Bluetooth-related follow-ups resolve with fewer clarifications in ≥ 30% of cases (if enhancements enabled).

## 9) Open Questions

These reflect unselected options from scoping:
1. Conversation surface: Web UI only vs. API + UI? (Default: Both.)
2. Memory scope: Short-term + rolling summary now; enable long-term per user/device? (Default: Short-term now; long-term optional.)
3. Memory storage: KV-only vs. KV + Durable Objects vs. D1? (Default: KV now; DO optional.)
4. User identity: Anonymous cookie vs. OAuth/magic link? (Default: Anonymous; can add auth later.)
5. Data retention: 30-day TTL vs. user-driven retention? (Default: 30-day; Clear Memory always available.)
6. Bluetooth enhancements: Which of device registry, GATT memory, event log ingestion should be in v1? (Default: device nicknames + notes.)
7. Knowledge base: Keep current RAG only vs. enable user uploads for device manuals? (Default: keep uploads as today.)
8. Response behavior: Add function/tool-calling schema now or later? (Default: define stubs only.)

## 10) Acceptance Criteria (per section)

- API
  - `POST /chat` returns either SSE stream or `{ answer, citations, conversationId }` JSON.
  - Maintains citations per factual sentence in the final answer.

- Memory (short-term)
  - After 10+ turns, conversation remains coherent without re-stating facts, verified on a test script.
  - Clearing memory removes rolling summary and turns; subsequent responses no longer use prior context.

- UI
  - Messages render as alternating bubbles with streaming effect.
  - Citations displayed under the assistant’s last message.
  - Clear/Rename/Export actions available and functional.

- Telemetry
  - Logs include CHAT_* markers with timing for embedding, retrieval, synthesis.

- Non-regression
  - `/query` endpoint continues to work as before.



