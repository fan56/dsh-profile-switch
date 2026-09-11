/**
 * ask.ts tests — envelope extraction between host ask-user answers and the
 * wizard's decisions, plus the agents-dir parser contract and the registry
 * probe's module validation.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { DECLINE_MESSAGE, answerFor, errorCode, isDeclinedEnvelope, multiPick, singlePick } from '../lib/ask.js'

// ------------------------------------------------------------------ helpers --

const questions = [
  { id: 'provider', question: 'Which provider?' },
  { id: 'model', question: 'Which model?' },
]

const answeredItem = (id, selected, custom) => ({
  id,
  selected,
  ...(custom !== undefined ? { custom } : {}),
})

// ------------------------------------------------------------------- picks --

test('singlePick: a non-empty custom overrides the selected label (host contract)', () => {
  const answer = { answers: [answeredItem('provider', ['zai'], 'my-provider')] }
  assert.equal(singlePick(answer, 'provider'), 'my-provider')
})

test('singlePick: falls back to the first selected label, trims custom whitespace', () => {
  assert.equal(singlePick({ answers: [answeredItem('provider', ['zai', 'volc'])] }, 'provider'), 'zai')
  assert.equal(singlePick({ answers: [answeredItem('provider', ['zai'], '   ')] }, 'provider'), 'zai')
})

test('singlePick: unanswered or skipped questions resolve undefined', () => {
  assert.equal(singlePick({ answers: [] }, 'model'), undefined)
  assert.equal(singlePick({ answers: [answeredItem('model', [])] }, 'model'), undefined)
})

test('multiPick: labels in selection order, empty when skipped', () => {
  assert.deepEqual(
    multiPick({ answers: [answeredItem('agents', ['b', 'a'])] }, 'agents'),
    ['b', 'a'],
  )
  assert.deepEqual(multiPick({ answers: [] }, 'agents'), [])
})

test('answerFor finds by id; errorCode reads the duck-typed code', () => {
  assert.equal(answerFor({ answers: [answeredItem('model', [])] }, 'model')?.id, 'model')
  assert.equal(answerFor({ answers: [] }, 'model'), undefined)
  assert.equal(errorCode(Object.assign(new Error('x'), { code: 'NO_PROVIDER' })), 'NO_PROVIDER')
  assert.equal(errorCode(new Error('plain')), undefined)
  assert.equal(errorCode(null), undefined)
  assert.equal(errorCode('string'), undefined)
})

// ----------------------------------------------------------------- decline --

test('isDeclinedEnvelope: every question empty-selected with the decline marker', () => {
  const declined = {
    answers: questions.map(question => answeredItem(question.id, [], DECLINE_MESSAGE)),
  }
  assert.equal(isDeclinedEnvelope(questions, declined), true)
})

test('isDeclinedEnvelope: any real engagement is not a decline', () => {
  const engaged = {
    answers: [
      answeredItem('provider', ['zai']),
      answeredItem('model', [], DECLINE_MESSAGE), // one declined question inside an answer
    ],
  }
  assert.equal(isDeclinedEnvelope(questions, engaged), false)
})

test('isDeclinedEnvelope: a skipped question without the marker is not a decline', () => {
  const skipped = { answers: [answeredItem('provider', []), answeredItem('model', [])] }
  assert.equal(isDeclinedEnvelope(questions, skipped), false)
  assert.equal(isDeclinedEnvelope([], { answers: [] }), false)
})
