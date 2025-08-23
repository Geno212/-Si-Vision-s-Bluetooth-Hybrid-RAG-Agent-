import type { Env, RetrievedChunk } from "../types";
import { embedText, expandQueries, vectorizeQuery, rerank } from "../retrieval";

export interface RetrievalResult {
  contextBlocks: Array<{ id: string; title?: string; source?: string; content: string }>;
  topScore: number;
  retrievalNotes: string[];
  knowledgeGaps: string[];
}

export class KnowledgeRetrievalAgent {
  async execute(env: Env, query: string): Promise<RetrievalResult> {
    console.log("[RetrievalAgent] Start", { query });
    // 1. Query expansion for recall
    const variants = await expandQueries(env, query, 3);
    const variantTexts = [query, ...variants];
    // 2. Embed and retrieve for each variant
    const vectors = await Promise.all(variantTexts.map((t) => embedText(env, t).catch(() => [] as number[])));
    const perQueryResults = await Promise.all(
      vectors.filter((v) => Array.isArray(v) && v.length > 0).map((v) => vectorizeQuery(env, v as number[], 20))
    );
    // 3. RRF fusion and deduplication
    const K = 60;
    const fused: Record<string, { item: RetrievedChunk; score: number }> = {};
    perQueryResults.forEach((list) => {
      list.forEach((m, idx) => {
        const rrf = 1 / (K + idx + 1);
        const existing = fused[m.id];
        if (!existing) fused[m.id] = { item: m, score: rrf }; else fused[m.id].score += rrf;
      });
    });
    let candidates = Object.values(fused)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((x) => x.item);
    // 4. Semantic clustering (advanced: by protocol layer/topic/semantic similarity)
    // Try to extract protocol layer/topic from metadata or content
    function extractTopic(chunk: RetrievedChunk): string {
      const meta = chunk.metadata || {};
      // Try protocol layer, function, or topic
      if (meta.protocol_layer) return String(meta.protocol_layer);
      if (meta.topic) return String(meta.topic);
      // Heuristic: look for keywords in content
      const content = chunk.content.toLowerCase();
      if (/controller|host|link layer|llcp|phy|rf|baseband/.test(content)) return "Controller/PHY";
      if (/gatt|gap|attribute|service|characteristic/.test(content)) return "GATT/GAP";
      if (/advertis|scan|beacon|observer/.test(content)) return "Advertising/Scanning";
      if (/security|encryption|pairing/.test(content)) return "Security";
      return meta.title || meta.source || "unknown";
    }
    const clusters: Record<string, RetrievedChunk[]> = {};
    for (const c of candidates) {
      const key = extractTopic(c);
      if (!clusters[key]) clusters[key] = [];
      clusters[key].push(c);
    }
    // 5. Cross-document linking: merge related facts from different docs
    // For each cluster, if multiple docs mention the same technical term, note it
    const retrievalNotes: string[] = [];
    const knowledgeGaps: string[] = [];
    const crossLinks: string[] = [];
    for (const [topic, blocks] of Object.entries(clusters)) {
      const termCounts: Record<string, number> = {};
      for (const b of blocks) {
        // Extract technical terms (simple: capitalized words, protocol acronyms)
        const terms = (b.content.match(/\b([A-Z]{2,}|[A-Z][a-z]+)\b/g) || []).filter(t => t.length > 2);
        for (const t of terms) termCounts[t] = (termCounts[t] || 0) + 1;
      }
      const shared = Object.entries(termCounts).filter(([_, n]) => n > 1).map(([t]) => t);
      if (shared.length) crossLinks.push(`Topic '${topic}' cross-linked terms: ${shared.join(", ")}`);
    }
    if (crossLinks.length) retrievalNotes.push(...crossLinks);

    // 6. Context window optimization: maximize coverage of all question aspects
    // Try to select blocks from as many clusters as possible, up to 20
    let contextBlocks: Array<{ id: string; title?: string; source?: string; content: string; sectionTag?: string }>= [];
    const perCluster = Math.max(1, Math.floor(20 / Object.keys(clusters).length));
    for (const [topic, blocks] of Object.entries(clusters)) {
      for (let i = 0; i < Math.min(perCluster, blocks.length); ++i) {
        // 7. Explicit section tagging
        contextBlocks.push({
          id: blocks[i].id,
          title: blocks[i].metadata?.title,
          source: blocks[i].metadata?.source,
          content: blocks[i].content,
          sectionTag: topic
        });
      }
    }
    // If not enough, fill up to 20
    if (contextBlocks.length < 20) {
      for (const c of candidates) {
        if (!contextBlocks.find(b => b.id === c.id)) {
          contextBlocks.push({
            id: c.id,
            title: c.metadata?.title,
            source: c.metadata?.source,
            content: c.content,
            sectionTag: extractTopic(c)
          });
        }
        if (contextBlocks.length >= 20) break;
      }
    }
    // 8. Gap detection: look for missing protocol layers, missing steps, or empty clusters
    if (Object.keys(clusters).length < 2) knowledgeGaps.push("Low diversity in sources; may miss cross-protocol insights.");
    if (contextBlocks.length === 0) knowledgeGaps.push("No relevant context found in RAG index.");
    const topScore = candidates[0]?.score ?? 0;
    retrievalNotes.push(`Clusters: ${Object.keys(clusters).length} [${Object.keys(clusters).join(", ")}], TopScore: ${topScore}`);
    if (crossLinks.length) retrievalNotes.push(...crossLinks);
    console.log("[RetrievalAgent] Done", { contextBlocks: contextBlocks.length, topScore, knowledgeGaps, retrievalNotes });
    return { contextBlocks, topScore, retrievalNotes, knowledgeGaps };
  }
}
