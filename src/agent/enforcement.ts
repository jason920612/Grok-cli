/**
 * SOP-enforcement tone for the corrective messages injected when the model
 * DEVIATES from the required process (laziness, doom-loops, ending with the plan
 * unfinished, wrong tool batching, re-planning spin, …).
 *
 * Two tones:
 *  - "firm" (default): blunt, forceful, professional.
 *  - "harsh": opt-in drill-sergeant correction with profanity, for users who
 *    want the model bluntly reprimanded the moment it cuts corners. Enable with
 *    GROK_HARSH=1 (or =harsh). The profanity is contained to these INTERNAL
 *    correction messages — the model is still told elsewhere to keep its reply
 *    to the user professional.
 *
 * Read once at module load so the tone is stable across the run (prefix-cache
 * friendly) and trivially toggled per process.
 */
const HARSH = /^(1|true|harsh|yes|on)$/i.test(process.env.GROK_HARSH ?? "");

export function harshEnforcementEnabled(): boolean {
  return HARSH;
}

/**
 * Wrap an SOP-violation correction. In "harsh" mode it gets a profane, blunt
 * reprimand around the (unchanged) substance so the actual instruction is never
 * lost. In "firm" mode the message is returned as-is.
 */
export function sopViolation(message: string): string {
  if (!HARSH) return message;
  return (
    `STOP — you're fucking up the process. ${message} ` +
    `No more cutting corners, no more bullshit shortcuts — do it RIGHT this time. ` +
    `(This is internal process discipline; keep your reply to the user professional.)`
  );
}
