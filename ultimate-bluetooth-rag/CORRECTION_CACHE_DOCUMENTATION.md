# Human-in-the-Loop Correction Cache System

## Overview

The Human-in-the-Loop (HITL) Correction Cache is a powerful enhancement to the Bluetooth RAG Agent that allows users to correct wrong answers and stores these corrections for future queries. This creates a continuously improving system that learns from user feedback.

## 🎯 Key Features

### 1. **Intelligent Cache-First Architecture**
- Every query first checks the correction cache using semantic similarity
- If a match is found (>90% similarity by default), returns the corrected answer immediately
- Falls back to normal RAG flow only when no correction exists

### 2. **Dual-Layer Matching**
- **Tier 1**: Exact normalized match in KV (< 5ms latency)
- **Tier 2**: Semantic similarity search using BGE-Large embeddings (< 50ms)
- Catches both identical and paraphrased questions

### 3. **User-Friendly Feedback Interface**
- ✅ **Approve button**: Acknowledge correct answers (tracked but not stored)
- ❌ **Correct button**: Opens modal to provide the right answer
- Optional: Add alternative question phrasings for better coverage
- Verified answers show a distinctive badge with confidence score

### 4. **Only Stores Corrections**
- Approved answers are **not** stored (reduces noise)
- Only stores when system is **wrong** (high-value signal)
- Creates a curated dataset of ground truth corrections

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      USER QUERY                              │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│  STAGE 1: Check Correction Cache                            │
│  • Normalize query                                           │
│  • Try exact match (KV)                                      │
│  • Try semantic match (Vectorize)                            │
└──────────────────┬──────────────────────────────────────────┘
                   │
         ┌─────────┴─────────┐
         │                   │
    FOUND (≥90%)         NOT FOUND
         │                   │
         ▼                   ▼
┌─────────────────┐   ┌─────────────────────────────────────────┐
│ Return Corrected│   │  STAGE 2: Normal RAG Flow               │
│ Answer          │   │  • Query expansion                       │
│ + Verified Badge│   │  • Vector retrieval                      │
└─────────────────┘   │  • Reranking                            │
                      │  • Agent synthesis                       │
                      └──────────────┬──────────────────────────┘
                                     │
                                     ▼
                      ┌──────────────────────────────────────────┐
                      │  STAGE 3: Present Answer + Feedback UI   │
                      │  [✅ Correct] [❌ Fix It]                │
                      └──────────────┬───────────────────────────┘
                                     │
                                (User clicks Fix It)
                                     │
                                     ▼
                      ┌──────────────────────────────────────────┐
                      │  STAGE 4: Correction Modal               │
                      │  • Show original Q&A                     │
                      │  • User provides correct answer          │
                      │  • Optional: Add question variants       │
                      └──────────────┬───────────────────────────┘
                                     │
                                     ▼
                      ┌──────────────────────────────────────────┐
                      │  STAGE 5: Store in Cache                 │
                      │  • Save to CORRECTION_QA_KV              │
                      │  • Embed & upsert to CORRECTION_QA_INDEX │
                      │  • Track metadata & analytics            │
                      └──────────────────────────────────────────┘
```

## 📦 Components

### Backend

#### 1. **Types** (`src/types.ts`)
- `CorrectionEntry`: Full correction metadata
- `CorrectionFeedbackRequest`: User submission payload
- `CorrectionCacheHit`: Cache lookup result
- `ChatResponseMetadata`: Indicates source and verification status

#### 2. **Corrections Module** (`src/corrections.ts`)
- `checkCorrectionCache()`: Lookup with semantic matching
- `storeCorrectionInCache()`: Save corrections with variants
- `getCorrectionById()`: Retrieve specific correction
- `deleteCorrectionById()`: Remove outdated corrections
- `normalizeQuery()`: Standardize query text

#### 3. **Main Integration** (`src/index.ts`)
- Modified `/chat` endpoint checks cache first
- New `/api/feedback/correct` endpoint for submissions
- Admin endpoints: `/api/corrections/:id`, `/api/corrections/stats`

### Frontend

#### 1. **UI Components** (`public/index.html`)
- Feedback buttons (approve/correct)
- Correction modal with form
- Verified answer badge

#### 2. **JavaScript** (`public/assets/main.js`)
- `addFeedbackButtons()`: Adds UI to assistant messages
- `handleCorrect()`: Opens correction modal
- `submitCorrection()`: Sends correction to API
- `addVerifiedBadge()`: Shows verification indicator

#### 3. **Styles** (`public/assets/styles.css`)
- Feedback button styling
- Modal form layout
- Verified badge appearance

### Infrastructure

#### 1. **Vectorize Index** (`correction-qa-index`)
- Dimensions: 1024 (BGE-Large)
- Metric: Cosine similarity
- Stores question embeddings with metadata pointers

#### 2. **KV Store** (`CORRECTION_QA_KV`)
- Stores full correction entries
- TTL: 365 days (configurable)
- Key format: `correction:{hash}`

## 🚀 Usage

### For End Users

1. **Ask a question** in the chat interface
2. **Review the answer**:
   - If correct: Click ✅ "This is correct" (optional)
   - If wrong: Click ❌ "Incorrect - Let me fix it"
3. **Provide correction** (if wrong):
   - The modal shows your question and the wrong answer
   - Type the correct answer in the text area
   - Optionally add alternative question phrasings
   - Click "💾 Save Correction"
4. **Future benefit**: Similar questions will now return your correction!

### For Administrators

#### View Cache Statistics
```bash
curl https://your-worker.dev/api/corrections/stats
```

Response:
```json
{
  "ok": true,
  "stats": {
    "configured": true,
    "threshold": 0.90,
    "ttlDays": 365
  }
}
```

#### Get Specific Correction
```bash
curl https://your-worker.dev/api/corrections/{correctionId}
```

#### Delete Outdated Correction
```bash
curl -X DELETE \
  -H "Authorization: Bearer YOUR_TOKEN" \
  https://your-worker.dev/api/corrections/{correctionId}
```

## ⚙️ Configuration

### Environment Variables (wrangler.toml)

```toml
[vars]
# Semantic similarity threshold (0.0 - 1.0)
CORRECTION_MATCH_THRESHOLD = "0.90"   # Higher = stricter matching

# Cache TTL in days
CORRECTION_CACHE_TTL_DAYS = "365"     # How long corrections persist
```

### Bindings

```toml
# Vector index for semantic search
[[vectorize]]
binding = "CORRECTION_QA_INDEX"
index_name = "correction-qa-index"

# KV store for correction metadata
[[kv_namespaces]]
binding = "CORRECTION_QA_KV"
id = "66cc4d73c2494507af23024a3259f309"
preview_id = "a0accde62d484d73a19be84bbeb55225"
```

## 📊 Data Model

### CorrectionEntry (KV)
```typescript
{
  id: string                          // SHA-256 hash of normalized question
  originalQuestion: string            // User's original query
  questionVariants: string[]          // Alternative phrasings
  normalizedQuestion: string          // Preprocessed version
  
  wrongAnswer: string                 // What RAG returned
  correctAnswer: string               // Human-provided correction
  
  wrongAnswerSources: string[]        // Chunk IDs that led to error
  correctAnswerSource?: string        // Reference doc/section
  
  correctedBy: string                 // User ID
  correctedAt: string                 // ISO timestamp
  
  timesReused: number                 // Usage analytics
  lastUsed?: string                   // Last served timestamp
  
  tags?: string[]                     // Optional categorization
}
```

### Vector Index Entry
```typescript
{
  id: string                          // Same as KV or {id}_v{n} for variants
  values: number[]                    // 1024-dim BGE-Large embedding
  metadata: {
    kvKey: string                     // Pointer to KV entry
    questionPreview: string           // First 100 chars
    correctionCount: number           // Number of times corrected
    lastUsed: string                  // For TTL/cleanup
    correctedBy: string               // For analytics
  }
}
```

## 🎨 UI/UX Details

### Verified Answer Badge
- Shows "✓ Verified Answer" with confidence percentage
- Green gradient background
- Appears at top of answer bubble
- Only shown for cache hits

### Feedback Buttons
- Appear below every non-verified assistant message
- Green "✅ This is correct" button
- Red "❌ Incorrect - Let me fix it" button
- Removed after user interacts

### Correction Modal
- Clean, focused form layout
- Shows original Q&A in read-only fields
- Large text area for correction
- Optional question variants section
- Clear save/cancel actions

## 🔒 Security & Privacy

### User Identity
- Anonymous user IDs stored in cookies (`bt_user_id`)
- No personal information collected
- Corrections associated with anonymous IDs

### Access Control
- Feedback submission: No authentication required
- Correction deletion: Requires `API_AUTH_TOKEN`
- Admin endpoints: Protected

### Data Retention
- Corrections expire after configurable TTL (default: 365 days)
- No automatic cleanup of vector entries (handled by Vectorize)
- Manual deletion available via admin API

## 📈 Analytics & Monitoring

### Key Metrics to Track
1. **Cache Hit Rate**: % of queries answered from cache
2. **Correction Volume**: New corrections per day
3. **Top Corrections**: Most frequently reused corrections
4. **Coverage**: Topics with most/least corrections
5. **User Engagement**: % of users providing corrections

### Logging
Console logs include:
- `[CORRECTION_CACHE]` prefix for all cache operations
- Cache hits/misses with confidence scores
- Storage operations with success/failure
- Usage statistics updates

Example:
```
[CORRECTION_CACHE] ✅ Semantic match found: "How does BLE pairing work..."
[CORRECTION_CACHE] 📊 Times reused: 15
[CORRECTION_CACHE] 💾 Storing correction with ID: a3f9c2b1e...
[CORRECTION_CACHE] ✅ Stored 3 vectors in index
```

## 🐛 Troubleshooting

### Cache Not Working
1. Check bindings are configured in `wrangler.toml`
2. Verify Vectorize index exists: `npx wrangler vectorize list`
3. Verify KV namespace exists: `npx wrangler kv namespace list`
4. Check console logs for `[CORRECTION_CACHE]` messages

### Low Cache Hit Rate
- Lower `CORRECTION_MATCH_THRESHOLD` (e.g., 0.85)
- Encourage users to add question variants
- Review normalization logic in `normalizeQuery()`

### False Positive Matches
- Increase `CORRECTION_MATCH_THRESHOLD` (e.g., 0.95)
- Review stored corrections for quality
- Delete outdated/incorrect corrections

## 🚀 Deployment

### Initial Setup
```bash
cd ultimate-bluetooth-rag

# Create Vectorize index (already done)
npx wrangler vectorize create correction-qa-index --dimensions=1024 --metric=cosine

# Create KV namespaces (already done)
npx wrangler kv namespace create CORRECTION_QA_KV
npx wrangler kv namespace create CORRECTION_QA_KV --preview

# Update wrangler.toml with IDs (already done)
# Deploy
npx wrangler deploy
```

### Verification
```bash
# Test cache stats endpoint
curl https://your-worker.dev/api/corrections/stats

# Test chat endpoint
curl -X POST https://your-worker.dev/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"test query"}]}'
```

## 🎓 Best Practices

### For Users
1. **Be specific**: Provide detailed correct answers
2. **Add context**: Include sources or references when possible
3. **Use variants**: Add alternative question phrasings
4. **Review before submit**: Ensure your correction is accurate

### For Administrators
1. **Monitor quality**: Regularly review new corrections
2. **Clean up**: Remove outdated corrections periodically
3. **Adjust threshold**: Fine-tune based on hit rate and accuracy
4. **Track patterns**: Identify weak areas in RAG knowledge base

### For Developers
1. **Test thoroughly**: Verify both cache hits and misses
2. **Handle errors**: Gracefully degrade if cache unavailable
3. **Log extensively**: Track cache performance metrics
4. **Version control**: Document threshold changes

## 📝 Future Enhancements

### Planned Improvements
- [ ] Bulk import of Q&A pairs
- [ ] Correction voting/verification by multiple users
- [ ] Auto-expire based on document updates
- [ ] Similarity-based correction suggestions
- [ ] A/B testing of answers
- [ ] Correction quality scoring
- [ ] Export corrections for fine-tuning
- [ ] Multi-language support
- [ ] Correction history/versioning

### Advanced Features
- [ ] Machine learning to predict correction needs
- [ ] Automated correction validation
- [ ] Collaborative correction review workflow
- [ ] Integration with feedback analytics tools

## 📚 References

- [Cloudflare Vectorize Documentation](https://developers.cloudflare.com/vectorize/)
- [Cloudflare Workers KV](https://developers.cloudflare.com/kv/)
- [BGE Embeddings](https://huggingface.co/BAAI/bge-large-en-v1.5)
- [RLHF (Reinforcement Learning from Human Feedback)](https://en.wikipedia.org/wiki/Reinforcement_learning_from_human_feedback)

---

## 💡 Summary

The Correction Cache system transforms your RAG agent into a **continuously learning system** that:
- ✅ Gets smarter with every correction
- ✅ Reduces response time for known questions
- ✅ Improves accuracy over time
- ✅ Empowers users to contribute their knowledge
- ✅ Creates a curated knowledge base of verified answers

**Result**: A self-improving AI assistant that learns from its mistakes!
