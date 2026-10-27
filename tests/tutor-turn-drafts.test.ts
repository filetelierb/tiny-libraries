import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acknowledgeTutorDraft,
  acknowledgeTutorAttachments,
  restoreTutorDraft,
  readTutorDraft,
  readTutorSubmission,
  newerConversation,
  conversationHasWork,
  type TutorSubmission,
} from '../src/tutor/turnDrafts';
import {
  turnSteeringCompatible,
  type ConversationDetail,
  type TurnScope,
} from '../shared/tutor-turns';

const stamp = () => crypto.randomUUID();
const submission = (): TutorSubmission => ({
  format: 2,
  draftStamp: stamp(),
  emptyStamp: stamp(),
  payload: {
    requestId: stamp(),
    prompt: 'Explain sampling',
    concepts: [],
    attachments: [],
    generation: { model: 'muse-spark-1.3', reasoningEffort: 'minimal' },
  },
});
test('acceptance clears only a sent draft revision, even when newer text is identical', () => {
  const sent = submission(),
    original = { text: sent.payload.prompt, stamp: sent.draftStamp! };
  assert.equal(acknowledgeTutorDraft(original, sent).text, '');
  const newer = { ...original, stamp: stamp() };
  assert.deepEqual(acknowledgeTutorDraft(newer, sent), newer);
  const erasedThenRetyped = { text: sent.payload.prompt, stamp: stamp() };
  assert.deepEqual(acknowledgeTutorDraft(erasedThenRetyped, sent), erasedThenRetyped);
});
test('an uncertain question restores only its untouched empty revision and preserves the original generation', () => {
  const sent = submission(),
    empty = { text: '', stamp: sent.emptyStamp! };
  const restored = restoreTutorDraft(empty, sent, true);
  assert.equal(restored.draft.text, sent.payload.prompt);
  assert.equal(restored.submission.restoredStamp, restored.draft.stamp);
  assert.equal(acknowledgeTutorDraft(restored.draft, restored.submission).text, '');
  assert.deepEqual(restored.submission.payload.generation, sent.payload.generation);
  const nextDraft = { text: 'Next question', stamp: stamp() };
  assert.deepEqual(restoreTutorDraft(nextDraft, sent, true).draft, nextDraft);
  assert.deepEqual(restoreTutorDraft(empty, sent, false).draft, empty);
});
test('stored request recovery preserves the exact older body and never infers a draft acknowledgement from text', () => {
  const old = { requestId: stamp(), prompt: 'Explain sampling', concepts: [], attachments: [] };
  const recovered = readTutorSubmission(JSON.stringify(old))!;
  assert.deepEqual(recovered.payload, old);
  assert.equal('generation' in recovered.payload, false);
  assert.equal('references' in recovered.payload, false);
  const current = readTutorDraft('', old.prompt);
  assert.deepEqual(acknowledgeTutorDraft(current, recovered), current);
  assert.equal(readTutorSubmission('{malformed'), null);
});
test('late polling cannot replace newer message history, queue controls or progress', () => {
  const base: ConversationDetail = {
    id: stamp(),
    sessionId: stamp(),
    name: 'Study',
    sourceIds: [],
    messages: [],
    createdAt: '2026-10-27',
    updatedAt: '2026-10-27T08:00:00Z',
    pending: true,
    runState: { sequence: 5, active: null, outbox: [] },
  };
  assert.equal(
    newerConversation(base, { ...base, runState: { ...base.runState!, sequence: 4 } }),
    base,
  );
  assert.equal(newerConversation(base, { ...base, updatedAt: '2026-10-27T07:00:00Z' }), base);
  const next = { ...base, pending: false, runState: { ...base.runState!, sequence: 6 } };
  assert.equal(newerConversation(base, next), next);
});

test('acceptance removes only the sent attachment selection, keeping reattached and newer items', () => {
  const sent = submission(),
    original = stamp(),
    added = stamp(),
    selection = stamp();
  sent.payload.attachments = [original];
  sent.attachmentStamps = { [original]: selection };
  const current = [{ id: original }, { id: added }];
  assert.deepEqual(
    acknowledgeTutorAttachments(current, { [original]: selection, [added]: stamp() }, sent),
    [{ id: added }],
  );
  assert.deepEqual(
    acknowledgeTutorAttachments(current, { [original]: stamp(), [added]: stamp() }, sent),
    current,
  );
  assert.deepEqual(
    acknowledgeTutorAttachments(current, {}, { ...sent, attachmentStamps: undefined }),
    current,
  );
});

test('background polling follows queued/running work and stops for a paused or cancelled queue', () => {
  assert.equal(conversationHasWork({ pending: true }), true);
  assert.equal(conversationHasWork({}), false);
  const base = {
    id: stamp(),
    status: 'queued' as const,
    revision: 1,
    prompt: 'Saved question',
    generation: { model: 'muse-spark-1.3' as const, reasoningEffort: 'minimal' as const },
    attachments: [],
    attempt: 0,
    partial: '',
    toolNames: [],
    stopRequested: false,
    canSteer: false,
    canEdit: true,
    canRetry: false,
  };
  const state = { sequence: 1, active: null, outbox: [base] };
  assert.equal(conversationHasWork({ pending: false, runState: state }), true);
  for (const status of ['editing', 'cancelled', 'interrupted'] as const)
    assert.equal(
      conversationHasWork({
        pending: false,
        runState: { ...state, outbox: [{ ...base, status }] },
      }),
      false,
    );
});

test('a plain steering instruction inherits active passage context without adding references or attachments', () => {
  const id = stamp(),
    context = {
      sourceId: id,
      sourceVersion: 1,
      sourceName: 'Passage.md',
      location: { quote: 'Selected passage' },
    };
  const active: TurnScope = {
    references: [{ id, version: 1, prepared: 'frozen' }],
    permanentReferences: [],
    context,
    concepts: [],
    attachments: [],
  };
  const queued: TurnScope = {
    references: [],
    permanentReferences: [],
    concepts: [],
    attachments: [],
  };
  assert.equal(turnSteeringCompatible(queued, active), true);
  assert.equal(
    turnSteeringCompatible({ ...queued, context: { ...context, sourceVersion: 2 } }, active),
    false,
  );
  assert.equal(turnSteeringCompatible({ ...queued, attachments: [stamp()] }, active), false);
  assert.equal(
    turnSteeringCompatible(
      { ...queued, permanentReferences: [{ id: stamp(), version: 1, prepared: 'new' }] },
      active,
    ),
    false,
  );
  const older: TurnScope = {
    references: [{ id, version: 1, prepared: 'saved-original-hash' }],
    concepts: [],
    attachments: [],
  };
  const updated: TurnScope = {
    ...older,
    permanentReferences: [{ id, version: 1, prepared: 'scoped-current-hash' }],
  };
  assert.equal(turnSteeringCompatible(updated, older), true);
  assert.equal(turnSteeringCompatible(older, updated), true);
  assert.equal(
    turnSteeringCompatible(updated, {
      ...updated,
      permanentReferences: [{ id, version: 1, prepared: 'changed' }],
    }),
    false,
  );
});
