/**
 * Wiring tests for dsh-notify.
 *
 * The rule these pin down is the one the plugin exists for: a notification
 * appears when a task is actually finished, and not once per round of a task
 * that is still running. That rule lives in the seam between two host events —
 * `session/event`'s durable `turn/end` and `agent/status`'s idle transition —
 * so a fake host is the only way to test it without driving a real agent.
 *
 * The Windows transport is injected, so nothing here puts a toast on a screen.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../lib/index.js';

const SESSION_ID = 'session-1';
const CWD = 'C:\\work\\app';

/** A recording transport: counts what would have been shown. */
function recordingTransport({ available = true } = {}) {
  const shown = [];
  return {
    shown,
    transportAvailability: () => (available ? { ok: true } : { ok: false, reason: 'not windows' }),
    showToast: options => {
      shown.push(options);
      return { pid: 4242, outcome: Promise.resolve({ ok: true }) };
    },
  };
}

/**
 * A stand-in for the host context.
 *
 * Only the surface dsh-notify touches exists: `on`/`get`/`logger`, plus the
 * session text a real host would serve through `sessionQuery`.
 */
function fakeHost({ title = '修复登录崩溃', summary = '改了三个文件，测试通过。', goals = new Map() } = {}) {
  const handlers = new Map();
  const warnings = [];
  const services = {
    sessionQuery: {
      readTitle: async () => ({ title }),
      readSurface: async () => ({
        events: [
          { type: 'user/message', data: {} },
          {
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: summary }] } },
          },
        ],
      }),
    },
    goals: { get: agent => goals.get(agent?.id) },
    agents: { get: id => ({ id }) },
  };
  return {
    handlers,
    warnings,
    sessionId: SESSION_ID,
    cwd: CWD,
    on(name, handler) {
      handlers.set(name, handler);
    },
    get(name) {
      return services[name];
    },
    logger: {
      info() {},
      warn(message) {
        warnings.push(message);
      },
    },
    services,
    /** Drive one durable turn end, the way the session log would. */
    turnEnd(seq, reason) {
      handlers.get('session/event')(
        { id: SESSION_ID, header: { id: SESSION_ID, cwd: CWD } },
        { type: 'turn/end', seq, time: 1_700_000_000_000, data: { turn: 1, reason } },
      );
    },
    /**
     * Drive one recorded tool call, the way the host records it.
     *
     * `arguments` is the raw JSON **string** the model streamed: the session
     * log stores `block.arguments` verbatim, before the dispatcher parses it.
     * Handing this harness a ready-made object would let a plugin that forgot
     * to parse pass every test while staying silent in production — which is
     * precisely what happened. So this stringifies by default, and `raw`
     * overrides it for malformed-input cases.
     */
    toolCall(name, args, { origin, raw } = {}) {
      const payload = raw !== undefined ? raw : args === undefined ? undefined : JSON.stringify(args);
      handlers.get('session/event')(
        { id: SESSION_ID, header: { id: SESSION_ID, cwd: CWD, ...(origin === undefined ? {} : { origin }) } },
        {
          type: 'tool/call',
          seq: 3,
          time: 1_700_000_000_000,
          data: { turn: 1, step: 1, callId: 'call-1', name, arguments: payload },
        },
      );
    },
    /** Drive one agent status transition. */
    status(status) {
      handlers.get('agent/status')({ agent: { id: SESSION_ID }, status }, { id: SESSION_ID });
    },
    dispose() {
      handlers.get('session/disposed')?.({ id: SESSION_ID });
    },
  };
}

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const settle = 5;

test('the order of idle and turn end does not matter', async () => {
  // The regression this pins down: the first released version scheduled the
  // announcement from the `idle` transition and required `turn/end` to have
  // arrived first. A host that reports idle *before* it commits the turn end
  // therefore never scheduled anything — the notification silently never
  // appeared, with no error and nothing to look at. Whichever arrives second
  // must still produce exactly one notification.
  for (const order of ['idle-first', 'turn-end-first']) {
    const host = fakeHost();
    const transport = recordingTransport();
    apply(host, { settleDelayMs: settle }, transport);

    host.status('running');
    if (order === 'idle-first') {
      host.status('idle');
      host.turnEnd(7, { kind: 'completed' });
    } else {
      host.turnEnd(7, { kind: 'completed' });
      host.status('idle');
    }
    await tick(settle + 25);

    assert.equal(transport.shown.length, 1, `${order}: expected exactly one notification`);
    assert.equal(transport.shown[0].title, '✅ 修复登录崩溃');
    host.dispose();
  }
});

test('a turn end is announced even when no idle transition is reported', async () => {
  // Belt and braces for the same failure: a composition may not publish an idle
  // transition for a session at all. The turn end is what defines the outcome,
  // so it is what has to be able to carry the announcement.
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  host.turnEnd(7, { kind: 'completed' });
  await tick(settle + 25);

  assert.equal(transport.shown.length, 1);
  assert.equal(transport.shown[0].title, '✅ 修复登录崩溃');
  host.dispose();
});

test('one finished turn produces exactly one notification', async () => {
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  host.status('running');
  host.turnEnd(7, { kind: 'completed' });
  host.status('idle');
  await tick(settle + 20);

  assert.equal(transport.shown.length, 1);
  assert.equal(transport.shown[0].title, '✅ 修复登录崩溃');
  assert.equal(transport.shown[0].body, '改了三个文件，测试通过。');
  assert.equal(transport.shown[0].sound, 'Default');
  assert.equal(transport.shown[0].silent, false);
  host.dispose();
});

test('a continuation is not announced as if the task had finished', async () => {
  // The idle transition schedules the announcement; a new turn starting inside
  // the delay is what makes it a step of something still running.
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { settleDelayMs: 40 }, transport);

  host.status('running');
  host.turnEnd(7, { kind: 'completed' });
  host.status('idle');
  await tick(10);
  host.status('running'); // the session picked the work back up
  await tick(60);

  assert.deepEqual(transport.shown, []);
  host.dispose();
});

test('a turn that ends while the agent keeps running is reported at the end', async () => {
  // Goal mode and continued work both look like this: turn ends, another turn
  // starts, and only the last one is followed by idle.
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  host.status('running');
  host.turnEnd(7, { kind: 'completed' });
  await tick(2);
  assert.equal(transport.shown.length, 0, 'a turn end alone must not notify');

  host.turnEnd(11, { kind: 'completed' });
  host.status('idle');
  await tick(settle + 20);

  assert.equal(transport.shown.length, 1, 'the finished work is announced once');
  host.dispose();
});

test('a subagent session stays silent', async () => {
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  host.handlers.get('session/event')(
    { id: 'child-1', header: { id: 'child-1', cwd: CWD, origin: 'subagent' } },
    { type: 'turn/end', seq: 3, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  );
  host.handlers.get('agent/status')({ agent: { id: 'child-1' }, status: 'idle' }, { id: 'child-1' });
  await tick(settle + 20);

  assert.deepEqual(transport.shown, []);
  host.dispose();
});

test('a user-cancelled turn says nothing', async () => {
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  host.status('running');
  host.turnEnd(7, { kind: 'aborted', reason: { kind: 'user' } });
  host.status('idle');
  await tick(settle + 20);

  assert.deepEqual(transport.shown, []);
  host.dispose();
});

test('a failure carries its message into the body', async () => {
  const host = fakeHost({ summary: '先试着重试。' });
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  host.status('running');
  host.turnEnd(9, { kind: 'error', error: { message: 'connect ETIMEDOUT 443' } });
  host.status('idle');
  await tick(settle + 20);

  assert.equal(transport.shown.length, 1);
  assert.equal(transport.shown[0].title, '❌ 修复登录崩溃');
  assert.equal(transport.shown[0].body, 'connect ETIMEDOUT 443 — 先试着重试。');
  assert.equal(transport.shown[0].sound, 'Reminder');
  host.dispose();
});

/**
 * A goal view shaped the way the host actually returns one.
 *
 * `@deepseek-ai/dsh-goal`'s `GoalService.view()` spreads the goal flat, so the
 * phase lives at `view.phase` and there is no nested `view.goal.status`. These
 * fixtures previously used `{ goal: { status } }`, a shape no host produces: the
 * assertions passed green while the real integration read `undefined` and
 * announced every round of a running goal. Keep this faithful.
 */
const goalView = (phase) => ({
  id: 'goal-1',
  revision: 1,
  objective: '修复登录崩溃',
  phase,
  maxGoalRounds: 256,
  roundsStarted: 1,
  activation: 'armed',
});

test('a goal suppresses its own rounds and announces its settlement instead', async () => {
  const goals = new Map([[SESSION_ID, goalView('active')]]);
  const host = fakeHost({ goals });
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  // Five rounds of a running goal: each ends, none is the task ending.
  host.status('running');
  for (let round = 1; round <= 5; round += 1) {
    host.turnEnd(round * 10, { kind: 'completed' });
    host.status('idle');
    await tick(settle + 10);
    host.status('running');
  }
  assert.deepEqual(transport.shown, [], 'rounds of a live goal stay silent');

  // The goal is met; the round driver stops and the agent goes idle.
  goals.set(SESSION_ID, goalView('complete'));
  host.turnEnd(99, { kind: 'completed' });
  host.status('idle');
  await tick(settle + 20);

  assert.equal(transport.shown.length, 1);
  assert.equal(transport.shown[0].title, '🎯 修复登录崩溃');
  assert.equal(transport.shown[0].sound, 'Default');
  host.dispose();
});

test('a running goal that stops for a person is announced', async () => {
  const goals = new Map([[SESSION_ID, goalView('active')]]);
  const host = fakeHost({ goals });
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  host.status('running');
  host.turnEnd(20, { kind: 'blocked' });
  host.status('idle');
  await tick(settle + 20);

  assert.equal(transport.shown.length, 1);
  assert.equal(transport.shown[0].title, '⏸️ 修复登录崩溃');
  host.dispose();
});

test('notifyOn attention only interrupts for a person', async () => {
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { notifyOn: 'attention', settleDelayMs: settle }, transport);

  host.status('running');
  host.turnEnd(1, { kind: 'completed' });
  host.status('idle');
  await tick(settle + 20);
  assert.deepEqual(transport.shown, []);

  host.status('running');
  host.turnEnd(2, { kind: 'blocked' });
  host.status('idle');
  await tick(settle + 20);
  assert.equal(transport.shown.length, 1);
  assert.equal(transport.shown[0].title, '⏸️ 修复登录崩溃');
  host.dispose();
});

test('notifyOn never is silent even for a failure', async () => {
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { notifyOn: 'never', settleDelayMs: settle }, transport);

  host.status('running');
  host.turnEnd(1, { kind: 'error', error: { message: 'boom' } });
  host.status('idle');
  await tick(settle + 20);

  assert.deepEqual(transport.shown, []);
  host.dispose();
});

test('the sound setting overrides the per-outcome choice', async () => {
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle, sound: 'silent' }, transport);

  host.status('running');
  host.turnEnd(1, { kind: 'completed' });
  host.status('idle');
  await tick(settle + 20);

  assert.equal(transport.shown.length, 1);
  assert.equal(transport.shown[0].silent, true);
  host.dispose();
});

test('a session with no title still produces a usable notification', async () => {
  const host = fakeHost({ title: '', summary: '' });
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  host.status('running');
  host.turnEnd(1, { kind: 'completed' });
  host.status('idle');
  await tick(settle + 20);

  assert.equal(transport.shown.length, 1);
  assert.equal(transport.shown[0].title, '✅ DSH');
  assert.equal(transport.shown[0].body, '');
  host.dispose();
});

test('an unavailable platform warns and registers nothing', () => {
  const host = fakeHost();
  const transport = recordingTransport({ available: false });
  apply(host, {}, transport);

  assert.equal(host.handlers.size, 0);
  assert.equal(host.warnings.length, 1);
  assert.match(host.warnings[0], /not windows/);
});

test('a disabled plugin registers nothing', () => {
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { enabled: false }, transport);

  assert.equal(host.handlers.size, 0);
  assert.deepEqual(host.warnings, []);
});

test('a summary read that throws degrades instead of breaking the notification', async () => {
  const host = fakeHost();
  host.services.sessionQuery.readSurface = async () => {
    throw new Error('session is gone');
  };
  host.services.sessionQuery.readTitle = async () => {
    throw new Error('session is gone');
  };
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  host.status('running');
  host.turnEnd(1, { kind: 'completed' });
  host.status('idle');
  await tick(settle + 20);

  assert.equal(transport.shown.length, 1);
  assert.equal(transport.shown[0].title, '✅ DSH');
  assert.deepEqual(host.warnings, []);
  host.dispose();
});

test('disposing a session cancels an announcement that has not fired', async () => {
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { settleDelayMs: 40 }, transport);

  host.status('running');
  host.turnEnd(1, { kind: 'completed' });
  host.status('idle');
  host.dispose();
  await tick(60);

  assert.deepEqual(transport.shown, []);
});

// A question is the case the turn-end machinery structurally cannot see:
// `ask_user_question` waits inside the step, so the turn never ends while a
// person is being waited on. These tests pin the separate path that covers it.
test('a question is announced at once, with no turn end involved', async () => {
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  host.status('running');
  host.toolCall('ask_user_question', {
    questions: [{ id: 'db', question: '你要用哪个数据库？' }],
  });
  await tick(20);

  // No turnEnd and no idle transition in this test on purpose: if the
  // announcement depended on either, nothing would be shown.
  assert.equal(transport.shown.length, 1);
  assert.equal(transport.shown[0].title, '❓ 修复登录崩溃');
  assert.equal(transport.shown[0].sound, 'Reminder');
  assert.match(transport.shown[0].body, /你要用哪个数据库？/);
  host.dispose();
});

test('a question is not delayed by the settle window', async () => {
  // The settle delay exists to coalesce rounds of one task; making someone wait
  // on it while the agent is blocked on them would be the wrong trade.
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { settleDelayMs: 5_000 }, transport);

  host.toolCall('ask_user_question', { questions: [{ id: 'q', question: '继续吗？' }] });
  await tick(30);

  assert.equal(transport.shown.length, 1);
  host.dispose();
});

test('ordinary tool calls are never announced', async () => {
  // The failure this guards: hooking `tool/call` and forgetting to filter by
  // tool name would put a toast on screen for every call the model makes.
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  host.status('running');
  for (const [name, args] of [
    ['pwsh', { command: 'ls' }],
    ['read', { file_path: 'a.txt' }],
    ['subagent', { prompt: 'go' }],
    ['ask_user_question_extra', { questions: [{ question: 'not the tool' }] }],
  ]) {
    host.toolCall(name, args);
  }
  await tick(20);

  assert.deepEqual(transport.shown, []);
  host.dispose();
});

test('notifyOn never silences a question', async () => {
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { notifyOn: 'never', settleDelayMs: settle }, transport);

  host.toolCall('ask_user_question', { questions: [{ id: 'q', question: '继续吗？' }] });
  await tick(20);

  assert.deepEqual(transport.shown, []);
  host.dispose();
});

test('a question in a subagent session stays silent', async () => {
  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  host.toolCall('ask_user_question', { questions: [{ id: 'q', question: '继续吗？' }] }, { origin: 'subagent' });
  await tick(20);

  assert.deepEqual(transport.shown, []);
  host.dispose();
});

test('a question call with no usable text is not announced', async () => {
  // `arguments` is model-authored JSON; a malformed call must stay quiet rather
  // than put "undefined" in a toast.
  for (const args of [undefined, {}, { questions: [] }, { questions: [{}] }]) {
    const host = fakeHost();
    const transport = recordingTransport();
    apply(host, { settleDelayMs: settle }, transport);

    host.toolCall('ask_user_question', args);
    await tick(20);

    assert.deepEqual(transport.shown, [], `args=${JSON.stringify(args)}`);
    host.dispose();
  }
});

test('an unparseable arguments string stays silent', async () => {
  // The host records the streamed string verbatim, so a truncated one reaches
  // here intact. JSON.parse throws on it; that must not become a toast, and
  // must not escape as an unhandled error inside the agent loop either.
  for (const raw of ['{"questions":[{"id":"q",', '', '   ', 'null', '"a string"', '42']) {
    const host = fakeHost();
    const transport = recordingTransport();
    apply(host, { settleDelayMs: settle }, transport);

    host.toolCall('ask_user_question', undefined, { raw });
    await tick(20);

    assert.deepEqual(transport.shown, [], `raw=${JSON.stringify(raw)}`);
    assert.deepEqual(host.warnings, [], `raw=${JSON.stringify(raw)} 不应产生 warning`);
    host.dispose();
  }
});

test('the exact payload a real session recorded is announced', async () => {
  // Captured verbatim from this machine's own session log
  // (~/.dsh/sessions/--D-0Coding-local-llm--/session-e253dbeb/…zstd, seq 1056),
  // so the fixture cannot drift from what the host really writes: a JSON
  // *string*, questions nested inside it. The first version of this feature
  // read `.questions` off that string, found undefined, and stayed silent in
  // production while a parsed-object fixture kept the tests green.
  const recorded =
    '{"questions":[{"id":"restart","question":"现在重启 DSH 让「模型提问时弹通知」生效吗？","header":"生效方式",'
    + '"options":[{"label":"现在重启（推荐）","description":"重启后新代码生效。"}],"multi_select":false}]}';

  const host = fakeHost();
  const transport = recordingTransport();
  apply(host, { settleDelayMs: settle }, transport);

  host.toolCall('ask_user_question', undefined, { raw: recorded });
  await tick(20);

  assert.equal(transport.shown.length, 1);
  assert.equal(transport.shown[0].title, '❓ 修复登录崩溃');
  assert.match(transport.shown[0].body, /现在重启 DSH 让「模型提问时弹通知」生效吗？/);
  host.dispose();
});
