import type { Env, ChatResponse, Citation } from "../types";
import { KnowledgeRetrievalAgent } from "./retrievalAgent";
import { SynthesisAgent } from "./synthesisAgent";
import { QualityValidationAgent } from "./validationAgent";
import { ValidationAgentWeb } from "./validationAgentWeb";

export class AgentOrchestrator {
  retrievalAgent = new KnowledgeRetrievalAgent();

  synthesisAgent = new SynthesisAgent();
  validationAgent = new QualityValidationAgent();
  validationAgentWeb = new ValidationAgentWeb();

  async processQuery(env: Env, conversationId: string, query: string, webContext?: any, memorySummary?: string, maxIter: number = 2): Promise<ChatResponse> {
    const MAX_ITER = typeof maxIter === 'number' && maxIter > 0 ? Math.min(maxIter, 10) : 2;
    let lastSynthesisNotes: string[] = [];
    let lastValidationNotes: string[] = [];
    let answer = "";
    let citations: Citation[] = [];
  const tRetrieval0 = Date.now();
  let retrieval: any = undefined;
  let retrievalError: any = null;
  let tRetrieval1 = tRetrieval0;
  // Metrics for all agents
  let tSynthesis0 = 0, tSynthesis1 = 0, synthesisError: any = null;
  let tValidation0 = 0, tValidation1 = 0, validationError: any = null;
  let tWebValidation0 = 0, tWebValidation1 = 0, webValidationError: any = null;
    try {
      retrieval = await this.retrievalAgent.execute(env, query);
      tRetrieval1 = Date.now();
    } catch (err) {
      retrievalError = err;
      tRetrieval1 = Date.now();
      console.error('[Metrics] RetrievalAgent error', err);
    }
    let synthesis: any = null;
    let validation: any = null;
    let feedback: string[] = [];
  for (let iter = 0; iter < MAX_ITER; ++iter) {
      console.log(`[Orchestrator] Iteration ${iter + 1}`);
      // Synthesis with feedback if any
  tSynthesis0 = Date.now();
  synthesisError = null;
  tSynthesis1 = tSynthesis0;
      try {
        if (retrieval) {
          synthesis = await this.synthesisAgent.execute(
            env,
            query + (feedback.length ? `\n\n[Validation Feedback]\n- ${feedback.join("\n- ")}` : ""),
            retrieval,
            webContext,
            memorySummary
          );
        } else {
          throw new Error('Retrieval failed, cannot synthesize');
        }
        tSynthesis1 = Date.now();
      } catch (err) {
        synthesisError = err;
        tSynthesis1 = Date.now();
        console.error('[Metrics] SynthesisAgent error', err);
      }
      lastSynthesisNotes = synthesis.synthesisNotes;
      // Validation
  tValidation0 = Date.now();
  validationError = null;
  tValidation1 = tValidation0;
      try {
        if (synthesis && retrieval) {
          validation = await this.validationAgent.execute(synthesis.answer, retrieval.contextBlocks, synthesis.synthesisNotes);
        } else {
          throw new Error('Synthesis or retrieval failed, cannot validate');
        }
        tValidation1 = Date.now();
      } catch (err) {
        validationError = err;
        tValidation1 = Date.now();
        console.error('[Metrics] ValidationAgent error', err);
      }
      lastValidationNotes = validation.validationNotes;
      // Second validation: web search
  tWebValidation0 = Date.now();
  let webValidation: any = undefined;
  webValidationError = null;
  tWebValidation1 = tWebValidation0;
      try {
        if (synthesis) {
          webValidation = await this.validationAgentWeb.execute(synthesis.answer, query, env);
        } else {
          throw new Error('Synthesis failed, cannot web-validate');
        }
        tWebValidation1 = Date.now();
      } catch (err) {
        webValidationError = err;
        tWebValidation1 = Date.now();
        console.error('[Metrics] ValidationAgentWeb error', err);
      }
      if (webValidation && webValidation.validationNotes && webValidation.validationNotes.length) {
        lastValidationNotes.push(...webValidation.validationNotes);
      }
      // Logging agent-to-agent feedback
      if (validation && validation.feedbackForSynthesis && validation.feedbackForSynthesis.length) {
        console.log("[Orchestrator] Validation feedback for synthesis", validation.feedbackForSynthesis);
        feedback = validation.feedbackForSynthesis;
      } else {
        feedback = [];
      }
      // If no feedback, break
      if (!feedback.length) break;
    }
  answer = validation ? validation.validated : "";
  citations = retrieval && retrieval.contextBlocks ? retrieval.contextBlocks.map((c: any, i: number) => ({ ref: `#${i + 1}`, id: c.id, title: c.title, source: c.source })) : [];
    // Log all agent outputs and metrics
    console.log("[Orchestrator] Final answer", { answerLength: answer.length, citations: citations.length, lastSynthesisNotes, lastValidationNotes });
    console.log('[Metrics] RetrievalAgent', {
      ms: tRetrieval1 - tRetrieval0,
      error: retrievalError ? String(retrievalError) : null,
      contextBlocks: retrieval && retrieval.contextBlocks ? retrieval.contextBlocks.length : 0
    });
    console.log('[Metrics] SynthesisAgent', {
      ms: tSynthesis1 - tSynthesis0,
      error: synthesisError ? String(synthesisError) : null
    });
    console.log('[Metrics] ValidationAgent', {
      ms: tValidation1 - tValidation0,
      error: validationError ? String(validationError) : null
    });
    console.log('[Metrics] ValidationAgentWeb', {
      ms: tWebValidation1 - tWebValidation0,
      error: webValidationError ? String(webValidationError) : null
    });
    return {
      conversationId,
      answer,
      citations
    };
  }
}
