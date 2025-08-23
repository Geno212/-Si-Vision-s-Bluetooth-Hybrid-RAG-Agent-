import type { Env, ChatMessage, Citation } from "./types";

export interface ConversationState {
  id: string;
  userId?: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  title?: string;
  summary?: string; // rolling summary of older turns
  pinned?: boolean; // if true, disable TTL expiration
  turns: ChatMessage[]; // chronological
  lastCitations?: Citation[]; // citations from the latest assistant message
}

const DEFAULT_TURN_WINDOW = 20;

function kvKeyForConversation(conversationId: string): string {
  return `conv:${conversationId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function getTurnWindow(env: Env): number {
  const n = Number((env as any).CHAT_TURN_WINDOW);
  return Number.isFinite(n) && n > 4 ? n : DEFAULT_TURN_WINDOW;
}

function getTtlSeconds(env: Env): number | undefined {
  const days = Number((env as any).CHAT_TTL_DAYS ?? 30);
  if (!Number.isFinite(days) || days <= 0) return undefined;
  return Math.floor(days * 24 * 60 * 60);
}

export async function getConversation(env: Env, conversationId: string): Promise<ConversationState | null> {
  if (!env.BT_RAG_CHAT_KV) return null;
  try {
    const raw = await env.BT_RAG_CHAT_KV.get(kvKeyForConversation(conversationId));
    if (!raw) return null;
    const obj = JSON.parse(raw) as ConversationState;
    if (!obj || obj.id !== conversationId) return null;
    // Per-access TTL refresh when not pinned
    const ttl = getTtlSeconds(env);
    if (ttl && !obj.pinned) {
      await env.BT_RAG_CHAT_KV.put(kvKeyForConversation(conversationId), JSON.stringify(obj), { expirationTtl: ttl });
    }
    return obj;
  } catch {
    return null;
  }
}

export async function ensureConversation(env: Env, conversationId: string, userId?: string): Promise<ConversationState | null> {
  const existing = await getConversation(env, conversationId);
  if (existing) return existing;
  if (!env.BT_RAG_CHAT_KV) return null;
  const fresh: ConversationState = {
    id: conversationId,
    userId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    turns: [],
  };
  const ttl = getTtlSeconds(env);
  await env.BT_RAG_CHAT_KV.put(kvKeyForConversation(conversationId), JSON.stringify(fresh), ttl ? { expirationTtl: ttl } : undefined);
  return fresh;
}

export async function saveConversation(env: Env, conv: ConversationState): Promise<void> {
  if (!env.BT_RAG_CHAT_KV) return;
  conv.updatedAt = nowIso();
  const ttl = getTtlSeconds(env);
  const options = conv.pinned || !ttl ? undefined : { expirationTtl: ttl } as { expirationTtl: number };
  await env.BT_RAG_CHAT_KV.put(kvKeyForConversation(conv.id), JSON.stringify(conv), options);
}

export async function appendMessage(env: Env, conversationId: string, message: ChatMessage, userId?: string): Promise<ConversationState | null> {
  if (!env.BT_RAG_CHAT_KV) return null;
  const conv = (await getConversation(env, conversationId)) ?? (await ensureConversation(env, conversationId, userId));
  if (!conv) return null;
  const msg: ChatMessage = { ...message, createdAt: message.createdAt || nowIso() };
  conv.turns.push(msg);
  // Enforce a hard cap to prevent unbounded growth; summary will keep earlier context
  const maxTurns = Math.max(getTurnWindow(env) * 3, 200);
  if (conv.turns.length > maxTurns) {
    conv.turns = conv.turns.slice(-maxTurns);
  }
  await saveConversation(env, conv);
  return conv;
}

export async function updateSummaryIfNeeded(env: Env, conversationId: string): Promise<ConversationState | null> {
  if (!env.BT_RAG_CHAT_KV) return null;
  const conv = await getConversation(env, conversationId);
  if (!conv) return null;
  const window = getTurnWindow(env);
  // If few turns, skip summarization
  if (conv.turns.length <= window) return conv;

  // Only summarize older turns, keep the last N explicit
  const older = conv.turns.slice(0, Math.max(0, conv.turns.length - window));
  const recent = conv.turns.slice(-window);
  const olderText = older.map(t => `${t.role}: ${t.content}`).join("\n").slice(0, 8000);
  const summaryPrompt = `Summarize the following conversation turns into a compact, factual memory (bullet points). Keep names, device ids, parameters, and decisions. Do not invent facts.\n\n${olderText}`;

  try {
    const res: any = await env.AI.run(env.MODEL_GENERATION, {
      input: summaryPrompt,
      temperature: 0.2,
      max_tokens: 300,
    });
    const text = String((res?.output_text || res?.text || res?.result?.output_text || "")).trim();
    if (text) conv.summary = text;
    // Optionally trim older turns now that they are summarized
    conv.turns = [...older.slice(-5), ...recent]; // keep a small tail from older for safety
    await saveConversation(env, conv);
    try { console.log("CHAT_SUMMARY_UPDATE", JSON.stringify({ conversationId, turns: conv.turns.length, summaryChars: (conv.summary || '').length })); } catch {}
  } catch {
    // If summarization fails, keep turns as-is
  }
  return conv;
}

export async function clearConversation(env: Env, conversationId: string): Promise<boolean> {
  if (!env.BT_RAG_CHAT_KV) return false;
  try { await env.BT_RAG_CHAT_KV.delete(kvKeyForConversation(conversationId)); return true; } catch { return false; }
}

export async function exportConversation(env: Env, conversationId: string): Promise<ConversationState | null> {
  return await getConversation(env, conversationId);
}


