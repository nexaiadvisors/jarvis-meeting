// What the talker is told around one researcher lookup. Pure, so the page, the text
// harness and the tests share the same wording.

/** Wait this long for the researcher before saying a short "let me check" line. */
export const RESEARCHER_ACK_AFTER_MS = 900

/** The tool result handed back at once, so the call never dangles while the lookup runs. */
export const RESEARCHER_STARTED_OUTPUT = { status: 'researching', note: 'The answer follows in a system message.' } as const

export function researcherAckDirective(): string {
  return [
    '[LOOKUP STARTED]',
    'The researcher is looking this up and the answer is not here yet.',
    'Say ONE short line now, five words or fewer, such as "Let me check." or "One moment." Do not guess the answer and do not say anything else.',
  ].join('\n')
}

/** `output` is the JSON body of POST /api/voice/ask-researcher (or an { error } object). */
export function researcherAnswerDirective(question: string, output: Record<string, unknown>): string {
  const answer = typeof output['answer'] === 'string' ? output['answer'].trim() : ''
  if (answer === '') {
    const instruction = typeof output['instruction'] === 'string' && output['instruction'].trim() !== ''
      ? output['instruction'].trim()
      : 'The lookup did not finish. Say that you could not look that up just now. Do not guess the answer.'
    return ['[LOOKUP FAILED]', `Question: "${question}"`, instruction].join('\n')
  }
  return [
    '[LOOKUP COMPLETE]',
    `The researcher answered the question "${question}":`,
    answer,
    'Say this answer now, in a natural voice. Keep every fact, date and caveat. Do not add facts of your own and do not shorten a list it gives. Do not repeat a "let me check" line.',
  ].join('\n')
}
