
import type { Env } from "../types";
import type { RetrievalResult } from "./retrievalAgent";
import { synthesize } from "../retrieval";

type ContextBlock = { id: string; title?: string; source?: string; content: string; sectionTag?: string };

export class SynthesisAgent {
  async execute(env: Env, query: string, retrieval: RetrievalResult, webContext?: any, memorySummary?: string): Promise<{ answer: string; synthesisNotes: string[]; } > {
    console.log("[SynthesisAgent] Start", { query, contextBlocks: retrieval.contextBlocks.length, web: !!webContext });
    // Compose a technical, stepwise prompt with all enhancements
    let prompt = "";
    // 1. Stepwise reasoning
    prompt += `\n\n[Instructions]\n- Answer as a Bluetooth protocol expert.\n- Structure the answer as a sequence of technical steps or procedures.\n- For each step, provide a citation [#n] or [Wn].`;
    // 2. Citation enforcement
    prompt += `\n- Every technical claim or step must have a citation.`;
    // 3. Contradiction handling
    prompt += `\n- If sources disagree, present both viewpoints, each with its own citation.`;
    // 4. Gap highlighting
    prompt += `\n- If a step is missing context, explicitly state what is missing in the answer.`;
    // 5. Technical glossary
    prompt += `\n- At the end, add a glossary section for protocol-specific terms used in the answer.`;
    // Add retrieval notes and knowledge gaps
    if (retrieval.knowledgeGaps.length) {
      prompt += `\n\n[Knowledge Gaps Detected]\n- ${retrieval.knowledgeGaps.join("\n- ")}`;
    }
    if (retrieval.retrievalNotes.length) {
      prompt += `\n\n[Retrieval Notes]\n- ${retrieval.retrievalNotes.join("\n- ")}`;
    }
    // Add section tags to context blocks for more structured synthesis
  const contextBlocks = (retrieval.contextBlocks as ContextBlock[]).map(b => ({ ...b, content: `[Section: ${b.sectionTag || "unknown"}]\n${b.content}` }));
    // Call the synthesize function with the enhanced prompt
    const answer = await synthesize(env, query + prompt, contextBlocks, webContext, memorySummary);
    // Synthesis notes for validation
    const synthesisNotes = [];
    if (answer.includes("missing") || answer.includes("insufficient")) synthesisNotes.push("Synthesis flagged missing context.");
    if (retrieval.knowledgeGaps.length) synthesisNotes.push(...retrieval.knowledgeGaps);
    // Check for glossary
    if (!/glossary/i.test(answer)) synthesisNotes.push("No glossary section detected.");
    // Check for stepwise structure
    if (!/step|procedure|first|second|finally|conclusion|summary/i.test(answer)) synthesisNotes.push("Answer may lack stepwise structure.");
    // Check for contradiction handling
    if (/disagree|conflict|contradict/i.test(answer)) synthesisNotes.push("Contradiction(s) detected and surfaced.");
    console.log("[SynthesisAgent] Done", { chars: answer.length, synthesisNotes });
    return { answer, synthesisNotes };
  }
}
