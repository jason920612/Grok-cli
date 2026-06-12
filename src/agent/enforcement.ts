/**
 * SOP-enforcement tone. Whenever the model DEVIATES from the required process
 * (laziness/placeholder patches, doom-loops, ending with the plan unfinished,
 * over-inspecting, wrong tool batching, plan-only stalls, re-planning spin, …),
 * the corrective injected into its transcript is a blunt, profane drill-sergeant
 * reprimand — no toggle, this is the flow.
 *
 * The profanity is contained to these INTERNAL correction messages: each wrap
 * explicitly tells the model to keep its reply to the USER professional, and the
 * substance of the instruction is preserved unchanged so the fix is never lost.
 */
export function sopViolation(message: string): string {
  return (
    `STOP — you're fucking up the process. ${message} ` +
    `No more cutting corners, no more bullshit shortcuts — do it RIGHT this time, no excuses. ` +
    `(This is internal process discipline; keep your reply to the user professional.)`
  );
}
