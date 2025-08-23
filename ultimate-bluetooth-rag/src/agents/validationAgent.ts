export class QualityValidationAgent {
  async execute(answer: string, contextBlocks: any[], notes: string[]): Promise<{ validated: string; validationNotes: string[]; feedbackForSynthesis?: string[] }> {
    const validationNotes: string[] = [];
    // 1. Citation-claim matching: every technical claim/step must end with a citation ([#n] or [Wn])
    const steps = answer.split(/\n+/).filter(l => l.trim().length > 0);
    let uncitedSteps = 0;
    let malformedCitations = 0;
    let uncitedStepTexts: string[] = [];
    let malformedCitationSteps: string[] = [];
    let allCitations: Set<string> = new Set();
    let duplicateCitations: Set<string> = new Set();
    let seenCitations: Set<string> = new Set();
    // Gather all valid context and web citation refs
    const validRefs = new Set<string>();
    if (contextBlocks && Array.isArray(contextBlocks)) {
      for (let i = 0; i < contextBlocks.length; ++i) validRefs.add(`#${i + 1}`);
    }
    // Optionally, add web refs if available (Wn)
    for (let i = 1; i <= 10; ++i) validRefs.add(`W${i}`);
    const citationRegex = /\[(#\d+|W\d+)\]/g;
    for (const step of steps) {
      if (/step|procedure|first|second|finally|conclusion|summary/i.test(step)) {
        // Enforce citation at end
        const match = step.match(/\[(#\d+|W\d+)\]$/);
        if (!match) {
          uncitedSteps++;
          uncitedStepTexts.push(step);
        } else {
          // Check for malformed citation (should be at end only)
          const allMatches = [...step.matchAll(citationRegex)];
          if (allMatches.length > 1 || (allMatches.length === 1 && !step.trim().endsWith(allMatches[0][0]))) {
            malformedCitations++;
            malformedCitationSteps.push(step);
          }
          // Track citations for deduplication and orphan check
          const ref = match[1];
          if (seenCitations.has(ref)) duplicateCitations.add(ref);
          seenCitations.add(ref);
          allCitations.add(ref);
        }
      }
    }
    if (uncitedSteps > 0) validationNotes.push(`Uncited steps: ${uncitedSteps}`);
    if (malformedCitations > 0) validationNotes.push(`Malformed citations: ${malformedCitations}`);
    if (duplicateCitations.size > 0) validationNotes.push(`Duplicate citations: ${Array.from(duplicateCitations).join(", ")}`);
    // Orphan citation check: any citation not in validRefs
    const orphanCitations = Array.from(allCitations).filter(ref => !validRefs.has(ref));
    if (orphanCitations.length > 0) validationNotes.push(`Orphan citations: ${orphanCitations.join(", ")}`);
    // Highlight/flag malformed or missing citations in feedback
    if (malformedCitationSteps.length > 0) validationNotes.push(`Malformed citation steps: ${malformedCitationSteps.length}`);
    // 2. Stepwise structure check and completeness
    const stepwiseKeywords = /step|procedure|first|second|finally|conclusion|summary/i;
    const hasStepwise = steps.some(s => stepwiseKeywords.test(s));
    if (!hasStepwise) {
      validationNotes.push("Answer may lack stepwise structure.");
    }
    // Stepwise completeness: check for missing expected steps (simple heuristic)
    const expectedSteps = ["first", "second", "finally"];
    for (const key of expectedSteps) {
      if (!steps.some(s => new RegExp(key, "i").test(s))) {
        validationNotes.push(`Stepwise completeness: missing step '${key}'.`);
      }
    }
    // 3. Advanced contradiction detection: flag if conflicting info not surfaced
    const contradictionWords = ["disagree", "conflict", "contradict", "inconsistent", "opposite", "contrary"];
    const contrastWords = ["however", "but", "although", "yet", "nevertheless", "on the other hand"];
    const contradictionPresent = contradictionWords.some(w => new RegExp(w, "i").test(answer));
    const contrastPresent = contrastWords.some(w => new RegExp(w, "i").test(answer));
    if (!contradictionPresent && contrastPresent) {
      validationNotes.push("Potential contradiction or contrast not explicitly surfaced.");
    }
    // 4. Fact-checking: ensure each claim is supported by context or web validation (simple heuristic)
    const contextText = (contextBlocks || []).map(b => b.content).join("\n");
    let unsupportedClaims = 0;
    for (const step of steps) {
      // If step is not found in context, flag as unsupported (skip glossary/notes)
      if (stepwiseKeywords.test(step) && contextText && !contextText.toLowerCase().includes(step.toLowerCase().slice(0, 20))) {
        unsupportedClaims++;
      }
    }
    if (unsupportedClaims > 0) validationNotes.push(`Fact-check: ${unsupportedClaims} step(s) not clearly supported by context.`);
    // 4. Feedback loop: if validation fails, trigger re-synthesis with feedback
    let feedbackForSynthesis: string[] = [];
    if (validationNotes.length > 0) {
      feedbackForSynthesis = [
        "Validation feedback:",
        ...validationNotes,
        ...(uncitedStepTexts.length > 0
          ? [
              "Please add citations to the following uncited steps:",
              ...uncitedStepTexts.map((s, i) => `Step ${i + 1}: ${s}`)
            ]
          : []),
        ...(malformedCitationSteps.length > 0
          ? [
              "Please fix malformed citations in the following steps:",
              ...malformedCitationSteps.map((s, i) => `Step ${i + 1}: ${s}`)
            ]
          : []),
        ...(duplicateCitations.size > 0
          ? [
              `Please avoid duplicate citations: ${Array.from(duplicateCitations).join(", ")}`
            ]
          : []),
        ...(orphanCitations.length > 0
          ? [
              `Please remove or fix orphan citations: ${orphanCitations.join(", ")}`
            ]
          : []),
        ...(notes || [])
      ];
    }
    // 5. Integrate synthesis notes
    if (notes && notes.length) validationNotes.push(...notes);
    // 6. Log and return
    console.log("[ValidationAgent] Validating answer", { chars: answer.length, validationNotes });
    let validated = answer;
    if (validationNotes.length) {
      validated += `\n\n[Validation Notes]\n- ${validationNotes.join("\n- ")}`;
    }
    return { validated, validationNotes, feedbackForSynthesis };
  }
}
