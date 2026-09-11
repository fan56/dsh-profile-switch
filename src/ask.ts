/**
 * ask-user answer-extraction helpers — the pure layer between the host's
 * `userQuestions.ask()` envelopes and the wizard's decisions.
 *
 * Envelope facts this module encodes (from @deepseek-ai/dsh-user-questions):
 * - Every question id is echoed with `{ selected: string[], custom?: string }`.
 * - For single-select questions a non-empty `custom` (the "Other" free text)
   * OVERRIDES `selected`; for multi-select it may accompany it.
 * - A question the user left untouched comes back as `selected: []` (and no
 *   custom) — the surfaces' explicit "skip" gesture.
 * - Declining the WHOLE request is canonical: every question answered with
 *   an empty `selected` and `custom` set to DECLINE_MESSAGE. The string must
 *   match the answering surfaces byte-for-byte (dsh-tui-pi's ask-user panel
 *   and any other answerer that follows the convention).
 */

import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions'

/** The canonical all-questions decline marker (matches dsh-tui-pi's panel). */
export const DECLINE_MESSAGE = 'User declined to answer questions.'

/** Extract the stable machine-routable code from a host error, duck-typed. */
export function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** The answer item for one question id, or `undefined` when unanswered. */
export function answerFor(
  answer: AskUserQuestionAnswer,
  id: string,
): AskUserQuestionAnswerItem | undefined {
  return answer.answers.find(item => item.id === id)
}

/**
 * The single-select pick for one question: free text wins, else the first
 * selected label. `undefined` = skipped (empty selection, no text).
 */
export function singlePick(answer: AskUserQuestionAnswer, id: string): string | undefined {
  const item = answerFor(answer, id)
  if (item === undefined) return undefined
  const custom = item.custom?.trim()
  if (custom !== undefined && custom !== '') return custom
  return item.selected[0]
}

/** The multi-select picks for one question (labels, in selection order). */
export function multiPick(answer: AskUserQuestionAnswer, id: string): string[] {
  return answerFor(answer, id)?.selected ?? []
}

/**
 * Whether the envelope is the canonical whole-request decline: every
 * question present, every one empty-selected with the decline marker. Any
 * normal answer means the user engaged — not a decline.
 */
export function isDeclinedEnvelope(
  questions: readonly AskUserQuestionItem[],
  answer: AskUserQuestionAnswer,
): boolean {
  if (questions.length === 0) return false
  return questions.every(question => {
    const item = answerFor(answer, question.id)
    return item !== undefined
      && item.selected.length === 0
      && (item.custom ?? '') === DECLINE_MESSAGE
  })
}
