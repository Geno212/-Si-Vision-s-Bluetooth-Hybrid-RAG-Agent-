/**
 * Human-in-the-Loop Correction Cache Module
 * 
 * This module manages a cache of user-corrected Q&A pairs that override
 * the standard RAG pipeline when semantic matches are found.
 */

import type { Env, CorrectionEntry, CorrectionCacheHit, CorrectionFeedbackRequest } from "./types";
import { embedTextSingle } from "./retrieval";

/**
 * Normalize query for better matching and deduplication
 * Removes common stop words, punctuation, and standardizes formatting
 */
export function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .trim()
    // Remove punctuation
    .replace(/[?!.,;:'"()\[\]{}]/g, '')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    // Remove common question words (optional - can increase match rate)
    .replace(/\b(what|how|why|when|where|who|which|is|are|was|were|the|a|an|do|does|did|can|could|should|would)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generate KV key for a correction entry
 */
export function correctionCacheKey(questionId: string): string {
  return `correction:${questionId}`;
}

/**
 * Hash a string to create a deterministic ID using SHA-256
 */
async function hashString(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/**
 * Check if a correction exists for this query
 * 
 * Two-tier lookup strategy:
 * 1. Fast path: Exact normalized match in KV (< 5ms)
 * 2. Semantic path: Vector similarity search for paraphrases (< 50ms)
 * 
 * @returns CorrectionCacheHit with found status and correction data
 */
export async function checkCorrectionCache(
  env: Env,
  query: string
): Promise<CorrectionCacheHit> {
  // Guard: Correction cache not configured
  if (!env.CORRECTION_QA_INDEX || !env.CORRECTION_QA_KV) {
    console.log(`[CORRECTION_CACHE] ⚠️  Cache not configured, skipping check`);
    return { found: false, confidence: 0 };
  }

  const threshold = Number(env.CORRECTION_MATCH_THRESHOLD || "0.90");
  const normalized = normalizeQuery(query);

  try {
    // ========================================================================
    // TIER 1: Exact Match (Fast Path)
    // ========================================================================
    const exactId = await hashString(normalized);
    const exactKey = correctionCacheKey(exactId);
    const exactMatch = await env.CORRECTION_QA_KV.get(exactKey);
    
    if (exactMatch) {
      const correction: CorrectionEntry = JSON.parse(exactMatch);
      console.log(`[CORRECTION_CACHE] ✅ Exact match found for: "${query.slice(0, 60)}..."`);
      
      // Update usage stats
      correction.timesReused = (correction.timesReused || 0) + 1;
      correction.lastUsed = new Date().toISOString();
      await env.CORRECTION_QA_KV.put(exactKey, JSON.stringify(correction));
      
      return { 
        found: true, 
        confidence: 1.0, 
        correction,
        matchedVariant: correction.originalQuestion
      };
    }

    // ========================================================================
    // TIER 2: Semantic Search (Paraphrase Matching)
    // ========================================================================
    console.log(`[CORRECTION_CACHE] 🔍 No exact match, trying semantic search...`);
    console.log(`[CORRECTION_CACHE] 🔍 Original query: "${query}"`);
    console.log(`[CORRECTION_CACHE] 🔍 Normalized query: "${normalized}"`);
    
    const queryVector = await embedTextSingle(env, query, true); // use query prefix
    console.log(`[CORRECTION_CACHE] 📊 Query vector length: ${queryVector.length}`);
    console.log(`[CORRECTION_CACHE] 📊 Query vector sample: [${queryVector.slice(0, 5).map(v => v.toFixed(4)).join(', ')}...]`);
    
    // Convert to Float32Array (same as working retrieval code)
    const fvec = new Float32Array(queryVector);
    
    let result: any;
    try {
      // Try object-form first (v2 API)
      console.log(`[CORRECTION_CACHE] 📤 Trying object-form query API...`);
      result = await (env.CORRECTION_QA_INDEX as any).query({ 
        vector: fvec, 
        topK: 3, 
        returnMetadata: true 
      });
      console.log(`[CORRECTION_CACHE] ✅ Object-form query succeeded`);
    } catch (err1: any) {
      console.log(`[CORRECTION_CACHE] ⚠️ Object-form query failed: ${err1.message}`);
      try {
        // Fallback to positional-form (older bindings): query(vector, options)
        console.log(`[CORRECTION_CACHE] 📤 Trying positional-form query API...`);
        result = await (env.CORRECTION_QA_INDEX as any).query(fvec, { 
          topK: 3, 
          returnMetadata: true 
        });
        console.log(`[CORRECTION_CACHE] ✅ Positional-form query succeeded`);
      } catch (err2: any) {
        console.log(`[CORRECTION_CACHE] ❌ Positional-form query also failed: ${err2.message}`);
        throw err2;
      }
    }

    console.log(`[CORRECTION_CACHE] 📊 Vectorize query returned ${result.matches?.length || 0} matches`);
    
    if (result.matches && result.matches.length > 0) {
      result.matches.forEach((match: any, idx: number) => {
        console.log(`[CORRECTION_CACHE] 📊 Match ${idx + 1}: score=${match.score.toFixed(3)}, id=${match.id}, preview="${match.metadata?.questionPreview || 'N/A'}"`);
      });
      
      const topMatch = result.matches[0];
      
      console.log(`[CORRECTION_CACHE] Top semantic match: score=${topMatch.score.toFixed(3)}, threshold=${threshold}`);
      
      if (topMatch.score >= threshold) {
        const kvKey = topMatch.metadata?.kvKey as string;
        
        if (!kvKey) {
          console.error(`[CORRECTION_CACHE] ❌ Match found but no kvKey in metadata`);
          return { found: false, confidence: topMatch.score };
        }
        
        const correctionData = await env.CORRECTION_QA_KV.get(kvKey);
        
        if (correctionData) {
          const correction: CorrectionEntry = JSON.parse(correctionData);
          
          // Update usage stats
          correction.timesReused = (correction.timesReused || 0) + 1;
          correction.lastUsed = new Date().toISOString();
          await env.CORRECTION_QA_KV.put(kvKey, JSON.stringify(correction));
          
          console.log(`[CORRECTION_CACHE] ✅ Semantic match found: "${correction.originalQuestion.slice(0, 60)}..."`);
          console.log(`[CORRECTION_CACHE] 📊 Times reused: ${correction.timesReused}`);
          
          return {
            found: true,
            confidence: topMatch.score,
            correction,
            matchedVariant: topMatch.metadata?.questionPreview as string,
          };
        } else {
          console.error(`[CORRECTION_CACHE] ❌ Match found but KV entry missing: ${kvKey}`);
        }
      } else {
        console.log(`[CORRECTION_CACHE] ⚠️  Best match score ${topMatch.score.toFixed(3)} below threshold ${threshold}`);
      }
    } else {
      console.log(`[CORRECTION_CACHE] ℹ️  No semantic matches found in vector index`);
    }

    console.log(`[CORRECTION_CACHE] ❌ No correction found for: "${query.slice(0, 60)}..."`);
    return { found: false, confidence: 0 };
    
  } catch (error) {
    console.error(`[CORRECTION_CACHE] 💥 Error during cache check:`, error);
    return { found: false, confidence: 0 };
  }
}

/**
 * Store a user correction in the cache
 * 
 * Process:
 * 1. Create or update KV entry with correction metadata
 * 2. Embed question and all variants
 * 3. Upsert vectors to CORRECTION_QA_INDEX
 * 
 * @returns Success status and correction ID
 */
export async function storeCorrectionInCache(
  env: Env,
  feedback: {
    originalQuery: string;
    wrongAnswer: string;
    correctAnswer: string;
    questionVariants?: string[];
    correctedBy: string;
    wrongAnswerSources?: string[];
    correctAnswerSource?: string;
    notes?: string;
  }
): Promise<{ success: boolean; id?: string; error?: string }> {
  
  if (!env.CORRECTION_QA_INDEX || !env.CORRECTION_QA_KV) {
    console.error(`[CORRECTION_CACHE] ❌ Cache not configured`);
    return { success: false, error: "Correction cache not configured" };
  }

  try {
    const normalized = normalizeQuery(feedback.originalQuery);
    const id = await hashString(normalized);
    const kvKey = correctionCacheKey(id);

    console.log(`[CORRECTION_CACHE] 💾 Storing correction with ID: ${id}`);

    // ========================================================================
    // STEP 1: Check if correction already exists
    // ========================================================================
    const existing = await env.CORRECTION_QA_KV.get(kvKey);
    let correction: CorrectionEntry;

    if (existing) {
      // Update existing correction
      correction = JSON.parse(existing);
      
      console.log(`[CORRECTION_CACHE] 📝 Updating existing correction`);
      
      correction.correctAnswer = feedback.correctAnswer;
      correction.wrongAnswer = feedback.wrongAnswer;
      
      // Merge question variants (deduplicate)
      correction.questionVariants = [
        ...new Set([
          ...(correction.questionVariants || []),
          ...(feedback.questionVariants || [])
        ])
      ];
      
      correction.correctedBy = feedback.correctedBy;
      correction.correctedAt = new Date().toISOString();
      
      if (feedback.wrongAnswerSources) {
        correction.wrongAnswerSources = feedback.wrongAnswerSources;
      }
      
      if (feedback.correctAnswerSource) {
        correction.correctAnswerSource = feedback.correctAnswerSource;
      }
      
    } else {
      // Create new correction
      console.log(`[CORRECTION_CACHE] ✨ Creating new correction entry`);
      
      correction = {
        id,
        originalQuestion: feedback.originalQuery,
        normalizedQuestion: normalized,
        questionVariants: feedback.questionVariants || [],
        wrongAnswer: feedback.wrongAnswer,
        correctAnswer: feedback.correctAnswer,
        wrongAnswerSources: feedback.wrongAnswerSources || [],
        correctAnswerSource: feedback.correctAnswerSource,
        correctedBy: feedback.correctedBy,
        correctedAt: new Date().toISOString(),
        timesReused: 0,
        originalScore: 0,
        tags: [],
      };
    }

    // ========================================================================
    // STEP 2: Store in KV with TTL
    // ========================================================================
    const ttlDays = Number(env.CORRECTION_CACHE_TTL_DAYS || "365");
    const ttlSeconds = ttlDays * 24 * 60 * 60;
    
    await env.CORRECTION_QA_KV.put(kvKey, JSON.stringify(correction), {
      expirationTtl: ttlSeconds,
    });

    console.log(`[CORRECTION_CACHE] ✅ Stored in KV with TTL: ${ttlDays} days`);

    // ========================================================================
    // STEP 3: Embed and store in vector index
    // ========================================================================
    // Store main question + all variants for better coverage
    const questionsToEmbed = [
      feedback.originalQuery,
      ...(feedback.questionVariants || [])
    ].filter(q => q && q.trim().length > 0); // Remove empty strings

    console.log(`[CORRECTION_CACHE] 🔢 Embedding ${questionsToEmbed.length} question variants...`);
    questionsToEmbed.forEach((q, idx) => {
      console.log(`[CORRECTION_CACHE] 🔢 Variant ${idx}: "${q.slice(0, 80)}..."`);
    });

    const embeddings = await Promise.all(
      questionsToEmbed.map(q => embedTextSingle(env, q, true)) // use query prefix
    );

    console.log(`[CORRECTION_CACHE] 📊 Generated ${embeddings.length} embeddings`);
    embeddings.forEach((emb, idx) => {
      console.log(`[CORRECTION_CACHE] 📊 Embedding ${idx}: length=${emb.length}, sample=[${emb.slice(0, 3).map(v => v.toFixed(4)).join(', ')}...]`);
    });

    const vectorEntries = embeddings.map((values, idx) => ({
      id: idx === 0 ? id : `${id}_v${idx}`, // variants get suffixed IDs
      values,
      metadata: {
        kvKey,
        questionPreview: questionsToEmbed[idx].slice(0, 100),
        correctionCount: 1,
        lastUsed: correction.correctedAt,
        correctedBy: correction.correctedBy,
      }
    }));

    console.log(`[CORRECTION_CACHE] 📤 Upserting ${vectorEntries.length} vectors to CORRECTION_QA_INDEX...`);
    vectorEntries.forEach((entry, idx) => {
      console.log(`[CORRECTION_CACHE] 📤 Vector ${idx}: id="${entry.id}", metadata.questionPreview="${entry.metadata.questionPreview}"`);
    });

    await env.CORRECTION_QA_INDEX.upsert(vectorEntries);

    console.log(`[CORRECTION_CACHE] ✅ Stored ${vectorEntries.length} vectors in index`);
    console.log(`[CORRECTION_CACHE] 🎉 Correction successfully saved!`);

    return { success: true, id };
    
  } catch (error) {
    console.error(`[CORRECTION_CACHE] 💥 Storage error:`, error);
    return { success: false, error: String(error) };
  }
}

/**
 * Get a specific correction by ID
 */
export async function getCorrectionById(
  env: Env,
  correctionId: string
): Promise<CorrectionEntry | null> {
  if (!env.CORRECTION_QA_KV) return null;
  
  try {
    const kvKey = correctionCacheKey(correctionId);
    const data = await env.CORRECTION_QA_KV.get(kvKey);
    
    if (!data) return null;
    
    return JSON.parse(data) as CorrectionEntry;
  } catch (error) {
    console.error(`[CORRECTION_CACHE] Error fetching correction ${correctionId}:`, error);
    return null;
  }
}

/**
 * Delete a correction from cache
 */
export async function deleteCorrectionById(
  env: Env,
  correctionId: string
): Promise<{ success: boolean; error?: string }> {
  if (!env.CORRECTION_QA_KV || !env.CORRECTION_QA_INDEX) {
    return { success: false, error: "Cache not configured" };
  }
  
  try {
    const kvKey = correctionCacheKey(correctionId);
    
    // Delete from KV
    await env.CORRECTION_QA_KV.delete(kvKey);
    
    // Note: Vectorize doesn't have a delete API yet, vectors will naturally expire
    // or be overwritten. This is acceptable for this use case.
    
    console.log(`[CORRECTION_CACHE] 🗑️  Deleted correction: ${correctionId}`);
    return { success: true };
    
  } catch (error) {
    console.error(`[CORRECTION_CACHE] Error deleting correction ${correctionId}:`, error);
    return { success: false, error: String(error) };
  }
}

/**
 * Get correction cache statistics
 * Note: This is a simplified version. Full implementation would require
 * scanning KV or maintaining separate counters.
 */
export async function getCorrectionStats(env: Env): Promise<{
  configured: boolean;
  threshold: number;
  ttlDays: number;
  totalCorrections?: number;
}> {
  return {
    configured: !!(env.CORRECTION_QA_INDEX && env.CORRECTION_QA_KV),
    threshold: Number(env.CORRECTION_MATCH_THRESHOLD || "0.90"),
    ttlDays: Number(env.CORRECTION_CACHE_TTL_DAYS || "365"),
  };
}
