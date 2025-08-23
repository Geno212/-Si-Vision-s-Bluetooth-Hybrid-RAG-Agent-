import type { Env } from "../types";
import { webSearchSerper } from "../retrieval";

export class ValidationAgentWeb {
  async execute(answer: string, query: string, env: Env): Promise<{ validationNotes: string[]; webContext: string; webSources: Array<{ title: string; link: string }> }> {
    // Always trigger Serper web search
    const web = await webSearchSerper(env, query);
    const validationNotes: string[] = [];
    if (!web || !web.sources || web.sources.length === 0) {
      validationNotes.push("[Web Validation] No web results found.");
      return { validationNotes, webContext: '', webSources: [] };
    }
    // Check if answer contains any web result snippet
    const found = web.sources.some(r => r.title && answer.includes(r.title));
    if (!found) {
      validationNotes.push("[Web Validation] No direct match between answer and web search titles.");
    } else {
      validationNotes.push("[Web Validation] At least one web search title matches the answer.");
    }
    return { validationNotes, webContext: web.context, webSources: web.sources };
  }
}
