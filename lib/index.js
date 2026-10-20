/**
 * dsh-notify — a Windows notification when a DSH task finishes.
 *
 * ## What "finished" means here
 *
 * The host offers two independent signals, and neither is sufficient alone:
 *
 * - `session/event` carries a durable `turn/end` with the reason the turn
 *   closed (`completed`, `error`, `aborted`, …), but a session can end a turn
 *   and immediately start the next one — that is exactly how goal mode and
 *   continued work behave. Announcing each of those would interrupt a person
 *   once per round for a task that is still running.
 * - `agent/status` reports `idle` only once no driver remains scheduled, which
 *   is the real "nothing further will happen on its own" moment, but it says
 *   nothing about how the work ended.
 *
 * So a turn ending is recorded, not announced, and the announcement happens at
 * the idle transition. That is what makes one notification mean one genuinely
 * finished piece of work rather than one round of something still running.
 *
 * ## Goals
 *
 * Goal mode runs one turn per round, so with the default setting every
 * intermediate round stays silent and the goal's own settlement (`complete` or
 * `blocked`) is announced once. A turn that stops because it needs a person —
 * a block, an error — is announced either way, because a goal waiting on a
 * human is no longer running on its own.
 *
 * ## Questions
 *
 * A question is the one case where the turn-end machinery above cannot see that
 * a person is needed, because the turn does not end: `ask_user_question` waits
 * for the answer inside the step, so the agent stays `running` and no
 * `turn/end` is ever committed while it waits. `blocked` does not cover it
 * either — the host only ends a turn that way for an archived session, a goal
 * round driver, or a hook that denies a call.
 *
 * So a question is announced from the `tool/call` the model's call already
 * produced, and it is announced immediately rather than through the settle
 * delay: the person is blocked on it, and the delay exists to coalesce turns,
 * not to make someone wait longer.
 *
 * Everything decision-shaped lives in `format.js` and everything that touches
 * Windows lives in `powershell-toast.js`; this file is wiring, because wiring
 * is the part that can only be read next to the host's event contracts.
 */
import Schema from '@deepseek-ai/schemastery';

import { NOTIFY_ON, SETTLE_DELAY_MAX_MS, SOUNDS, normalize } from './config.js';
import {
  buildNotification,
  isAttentionKind,
  kindForTurnEnd,
  notificationForGoal,
  notificationForTurn,
} from './format.js';
import { showToast, transportAvailability } from './powershell-toast.js';

/**
 * The tool whose call means "a person is being asked something".
 *
 * Detected off the durable `tool/call` event rather than the host's
 * `user-questions/request`: that one is a waterfall the asking flow itself
 * awaits, so a listener that got it wrong would stop the question from ever
 * reaching the GUI. A `tool/call` is already recorded by the time any plugin
 * sees it, which makes observing it free of consequences.
 */
const ASK_TOOL = 'ask_user_question';

export const name = 'dsh-notify';

/**
 * No `inject` on purpose, and this is load-bearing.
 *
 * A declared injection is a *wait*: Cordis keeps the plugin pending until that
 * service is present, and this host reported `fiberPhase: "pending"` for an
 * earlier version of this file that declared `{ optional: ['sessionQuery'] }` —
 * so the plugin never ran at all.
 *
 * `sessionQuery` is genuinely optional here: without it a notification loses
 * its title and summary, which is a degraded notification and not a broken
 * plugin. The service documentation gives exactly one shape for that — read it
 * with `ctx.get('sessionQuery')` and check for undefined, which is what the
 * `readTitle` / `readLastAssistantText` helpers below already do. Declaring it
 * as a dependency and treating it as optional were saying two different things.
 */

export { normalize };

export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('总开关。关闭后插件照常加载，但不发送任何通知。'),
  notifyOn: Schema.union(NOTIFY_ON)
    .default('every-turn')
    .description(
      '通知时机。every-turn：每个回合结束通知一次，但挂了目标的会话只在目标结束（完成／阻塞）时通知；attention：只在 agent 停下来等人（提问／阻塞／报错）时通知；never：从不通知。',
    ),
  onlyMainSessions: Schema.boolean()
    .default(true)
    .description('不通知子代理（subagent）会话，只通知你自己开的会话。'),
  settleDelayMs: Schema.number()
    .min(0)
    .max(SETTLE_DELAY_MAX_MS)
    .step(1)
    .default(400)
    .description('agent 进入空闲后再等这么久才发通知（毫秒），用于把紧接着继续的几个回合合并成一条。'),
  includeSummary: Schema.boolean()
    .default(true)
    .description('在通知正文里带上会话标题和最后一条回复的摘要。'),
  includeCwd: Schema.boolean().default(false).description('在通知里附带工作目录，便于区分同时运行的多个会话。'),
  summaryLimit: Schema.number()
    .min(0)
    .max(1000)
    .step(1)
    .default(220)
    .description('摘要正文的最大字符数，超出部分以省略号截断。'),
  sound: Schema.union(['kind', 'silent', ...SOUNDS])
    .default('kind')
    .description(
      '通知声音。kind：按结果类型自动选择（完成用 Default，报错用 Reminder）；silent：静音；其余为 WinRT 提示音名称。',
    ),
  appId: Schema.string()
    .default('')
    .description(
      '可选的 AppUserModelID（例如某个应用快捷方式的 AUMID）。留空则使用 DSH_APP_USER_MODEL_ID 环境变量，再回退到 Windows PowerShell。',
    ),
  debug: Schema.boolean()
    .default(false)
    .description('把每一次决策写进宿主日志（收到了哪个回合结束、为什么没通知）。排查「该弹没弹」时打开它。'),
});

/**
 * @param {object} ctx - the host context Cordis hands a plugin.
 * @param {object} [config] - raw config; normalized before use.
 * @param {object} [transport] - the Windows transport. Production never passes
 *   this; tests inject a recording transport so the wiring can be exercised
 *   without putting a toast on somebody's screen.
 */
export function apply(ctx, config, transport = { showToast, transportAvailability }) {
  const settings = normalize(config);

  // Checked before the platform: a user who turned the plugin off has said what
  // they want, and telling them the platform is unsupported on top of that is
  // noise. Both cases stay loaded rather than throwing, because one plugin must
  // not be able to stop a host from booting.
  if (!settings.enabled) {
    ctx.logger?.info?.('dsh-notify: loaded but disabled by config');
    return;
  }

  const availability = transport.transportAvailability();
  if (!availability.ok) {
    ctx.logger?.warn?.(`dsh-notify: notifications disabled — ${availability.reason}`);
    return;
  }

  /**
   * One record per direct session. It holds only what must outlive the event
   * that produced it — the turn's outcome, so it can be reported at the idle
   * transition — plus the title and working directory, which are attributes of
   * the session rather than of the turn.
   */
  const records = new Map();
  /** Last reported agent status per session: is the agent still working? */
  const running = new Map();

  const debug = message => {
    if (settings.debug) ctx.logger?.info?.(`dsh-notify: ${message}`);
  };

  const stateFor = sessionId => {
    let record = records.get(sessionId);
    if (record === undefined) {
      record = {
        sessionId,
        pendingKind: null,
        pendingDetail: '',
        pendingSeq: -1,
        title: '',
        cwd: '',
        summary: '',
        timer: null,
      };
      records.set(sessionId, record);
    }
    return record;
  };

  const cancel = record => {
    if (record.timer !== null) {
      clearTimeout(record.timer);
      record.timer = null;
    }
  };

  const clearPending = record => {
    record.pendingKind = null;
    record.pendingDetail = '';
    record.pendingSeq = -1;
  };

  const announce = (record, kind, detail) => {
    const payload = buildNotification({
      kind,
      title: record.title,
      cwd: record.cwd,
      summary: record.summary,
      detail,
      includeCwd: settings.includeCwd,
      bodyLimit: settings.summaryLimit,
    });
    const silent = settings.sound === 'silent';
    const sound = settings.sound === 'kind' ? payload.sound : settings.sound;
    try {
      const { outcome } = transport.showToast({
        appId: settings.appId || undefined,
        title: payload.title,
        body: payload.body,
        silent,
        sound,
      });
      // Reported, never awaited: the turn that triggered this must not wait on
      // PowerShell. The rejection handler is a belt-and-braces guard — a toast
      // that fails must not become an unhandled rejection in the host.
      outcome?.then?.(
        result => {
          if (!result?.ok) ctx.logger?.warn?.(`dsh-notify: toast was not shown — ${result?.reason ?? 'unknown'}`);
        },
        error => {
          ctx.logger?.warn?.(`dsh-notify: toast failed — ${describe(error)}`);
        },
      );
    } catch (error) {
      ctx.logger?.warn?.(`dsh-notify: could not start the notifier — ${describe(error)}`);
      return;
    }
    ctx.logger?.info?.(`dsh-notify: ${payload.kind} → ${record.sessionId} ${payload.title}`);
  };

  const report = async (record, pendingKind, detail) => {
    const sessionId = record.sessionId;

    // The agent is not running, so its driver is done — but the *session* may
    // still have somewhere to be: an armed goal means a round driver will resume
    // it. Announcing a round as "finished" would be a lie the user acts on, so a
    // live goal defers; only its settlement is announced.
    const status = goalStatus(ctx, sessionId);
    if (status === 'active') {
      const deferred = isAttentionKind(pendingKind) ? pendingKind : null;
      if (deferred === null) {
        debug(`deferred ${pendingKind} for ${sessionId}: a goal is still active`);
        return;
      }
      await summarize(record);
      announce(record, deferred, detail);
      return;
    }
    if (status !== undefined) {
      const goalKind = notificationForGoal({ notifyOn: settings.notifyOn, status });
      if (goalKind === null) {
        debug(`no notification for goal status ${status} (notifyOn=${settings.notifyOn})`);
        return;
      }
      await summarize(record);
      announce(record, goalKind, '');
      return;
    }

    const kind = notificationForTurn({ notifyOn: settings.notifyOn, kind: pendingKind });
    if (kind === null) {
      debug(`no notification for ${pendingKind} (notifyOn=${settings.notifyOn})`);
      return;
    }
    await summarize(record);
    announce(record, kind, detail);
  };

  /** Fill in the two session attributes a body is built from. */
  const summarize = async record => {
    if (!settings.includeSummary) return;
    record.title = await readTitle(ctx, record.sessionId, record.title);
    record.summary = await readLastAssistantText(ctx, record.sessionId);
  };

  /**
   * Announce a question the moment it is asked.
   *
   * Not routed through `fire()`: that function exists to suppress an
   * announcement while the agent is still working, and a question is precisely
   * the case where the agent *is* still running — parked inside the tool call —
   * and a person is what it waits for. The running check would discard it.
   */
  const announceQuestion = (record, detail) => {
    void (async () => {
      await summarize(record);
      announce(record, 'attention', detail);
    })().catch(error => {
      ctx.logger?.warn?.(`dsh-notify: could not announce a question for ${record.sessionId} — ${describe(error)}`);
    });
  };

  /**
   * A recorded tool call's arguments as an object, or undefined when unusable.
   *
   * The host stores the model's arguments as the raw JSON **string** it
   * streamed (`appendToolCall` records `block.arguments` verbatim, before the
   * tool dispatcher parses it). Reading `.questions` straight off that value
   * yields `undefined` for every call — a fix that reads as correct, passes any
   * test whose fixture uses an already-parsed object, and never fires once.
   * That is exactly how the first version of this shipped and stayed silent.
   */
  const toolArguments = data => {
    const raw = data?.arguments;
    if (raw !== null && typeof raw === 'object') return raw;
    if (typeof raw !== 'string' || raw.trim() === '') return undefined;
    try {
      const parsed = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
    } catch {
      // A truncated or malformed arguments string is a call the host will reject.
      return undefined;
    }
  };

  /**
   * The text of a question tool call, or undefined when there is nothing to say.
   *
   * Every field is model-authored, so each one is treated as unknown: a call
   * with no usable question must produce no notification rather than a toast
   * that reads "undefined".
   */
  const questionText = data => {
    const questions = toolArguments(data)?.questions;
    if (!Array.isArray(questions) || questions.length === 0) return undefined;
    // A `tool/call` is recorded *before* the tool runs, so a call the host is
    // about to reject for having no usable question is visible here too.
    // Announcing it would be a notification for a question nobody was ever
    // asked, so a call with no readable text stays silent instead.
    const asked = questions
      .map(entry => (typeof entry?.question === 'string' ? entry.question.trim() : ''))
      .find(text => text !== '');
    if (asked === undefined) return undefined;
    return questions.length > 1 ? `${asked}（共 ${questions.length} 个问题）` : asked;
  };

  /**
   * Schedule the announcement `settleDelayMs` from now.
   *
   * Only called from `turn/end`. Scheduling from the event that *defines* the
   * outcome is what makes this order-independent: an earlier version scheduled
   * from the `idle` transition and required `turn/end` to have arrived first, so
   * a host that reports idle before it commits the turn end never scheduled
   * anything at all. Idle is a filter here, not the trigger.
   */
  const schedule = (record, delay) => {
    if (record.timer !== null) clearTimeout(record.timer);
    record.timer = setTimeout(() => {
      record.timer = null;
      fire(record);
    }, delay);
  };

  /**
   * Announce what was recorded, unless the agent is demonstrably still working.
   *
   * The delay exists to coalesce a burst of turns. A *live* turn end inside it
   * will overwrite the record and re-arm the timer, so by fire time a record
   * older than one burst is no longer pending and this returns early.
   */
  const fire = record => {
    const pendingKind = record.pendingKind;
    const detail = record.pendingDetail;
    clearPending(record);
    if (pendingKind === null) {
      debug(`nothing pending for ${record.sessionId}`);
      return;
    }
    if (running.get(record.sessionId) === true) {
      // Something is still running: another turn, a subagent settling, a goal
      // round. Reporting now would call a running task finished.
      debug(`skipped ${pendingKind} for ${record.sessionId}: the agent is still running`);
      return;
    }
    void report(record, pendingKind, detail).catch(error => {
      ctx.logger?.warn?.(`dsh-notify: could not announce session ${record.sessionId} — ${describe(error)}`);
    });
  };

  ctx.on('session/event', (session, event) => {
    const sessionId = idOf(session);
    if (sessionId === undefined) return;

    // A question is not a turn end and never will be: `ask_user_question` parks
    // inside the step until it is answered (120s by default, forever with
    // `timeout: -1`), so no `turn/end` arrives while a person is being waited
    // on and the machinery below stays silent. The durable `tool/call` this
    // call already produces is the one passive signal for it — the host's own
    // `user-questions/request` is a waterfall the asking flow awaits, and a
    // notification has no business standing in that chain.
    if (event?.type === 'tool/call') {
      if (event.data?.name !== ASK_TOOL) return;
      const header = session?.header;
      if (settings.onlyMainSessions && header !== null && typeof header === 'object' && header.origin === 'subagent') {
        debug(`ignored a question for ${sessionId}: subagent session`);
        return;
      }
      if (settings.notifyOn === 'never') {
        debug(`no notification for a question in ${sessionId} (notifyOn=never)`);
        return;
      }
      const detail = questionText(event.data);
      if (detail === undefined) {
        debug(`ignored a question for ${sessionId}: the call carried no question text`);
        return;
      }
      const record = stateFor(sessionId);
      if (header !== null && typeof header === 'object' && typeof header.cwd === 'string' && header.cwd !== '') {
        record.cwd = header.cwd;
      }
      debug(`question asked in ${sessionId}: ${detail}`);
      announceQuestion(record, detail);
      return;
    }

    if (event?.type !== 'turn/end') return;
    const header = session?.header;
    if (header !== null && typeof header === 'object') {
      // A subagent's session is the agent's own business; the person waiting is
      // the parent session, whose notification covers it.
      if (settings.onlyMainSessions && header.origin === 'subagent') {
        debug(`ignored turn end for ${sessionId}: subagent session`);
        return;
      }
      const record = stateFor(sessionId);
      if (typeof header.cwd === 'string' && header.cwd !== '') record.cwd = header.cwd;
    } else {
      stateFor(sessionId);
    }
    const data = event.data;
    if (data === null || typeof data !== 'object') return;
    const kind = kindForTurnEnd(data.reason);
    if (kind === null) {
      debug(`ignored turn end for ${sessionId}: the reason is not worth a notification`);
      return;
    }
    const record = stateFor(sessionId);
    const detail = failureDetail(data.reason);
    record.pendingKind = kind;
    record.pendingDetail = detail;
    record.pendingSeq = typeof event.seq === 'number' ? event.seq : -1;
    // A committed turn end *is* the evidence that the work stopped, so the
    // worked-for status in hand is stale from here on. Without this, a session
    // whose host never publishes an idle transition would stay "running" in this
    // plugin's view forever and every announcement would be filtered out.
    running.set(sessionId, false);
    debug(`turn end for ${sessionId}: ${kind}${detail === '' ? '' : ` (${detail})`}`);
    // Deliberately scheduled from here, for every turn end. Whether a *rate* of
    // notifications is wanted is `notifyOn`'s business, and that is applied at
    // fire time by `report` — a decision this early would have to guess the
    // goal status of a moment that has not happened yet.
    schedule(record, settings.settleDelayMs);
  });

  ctx.on('agent/status', (payload, agent) => {
    const sessionId = idOf(agent) ?? idOf(payload?.agent);
    if (sessionId === undefined) return;
    const status = payload?.status;
    if (status !== 'idle' && status !== 'running') return;
    running.set(sessionId, status === 'running');
    debug(`agent ${sessionId} is now ${status}`);
    // Idle itself never schedules: the turn end already did, and ordering would
    // otherwise decide whether anything is sent. What a *running* transition
    // does is cancel — new work supersedes an announcement that has not gone out
    // yet, so a task that keeps going is not reported as finished.
    if (status === 'running') {
      const record = records.get(sessionId);
      if (record !== undefined) {
        cancel(record);
        clearPending(record);
      }
    }
  });

  // The last moment a record can be dropped without leaking: once the session
  // left the live registry, no further event will name it.
  ctx.on('session/disposed', session => {
    const sessionId = idOf(session);
    if (sessionId === undefined) return;
    const record = records.get(sessionId);
    if (record === undefined) return;
    cancel(record);
    records.delete(sessionId);
  });

  ctx.logger?.info?.('dsh-notify: watching for finished tasks');
}

/** The host object every event and service lookup goes through. */
function idOf(value) {
  const id = value?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * The session's goal status, or undefined when it has none.
 *
 * Read optionally and defensively: `ctx.get` returns undefined for a service
 * this composition does not have, and a goal service that is missing, older, or
 * shaped differently must simply mean "no goal" — never a failed notification.
 */
function goalStatus(ctx, sessionId) {
  try {
    const goals = ctx.get('goals');
    if (goals === undefined || typeof goals.get !== 'function') return undefined;
    const agents = ctx.get('agents');
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined;
    if (agent === undefined) return undefined;
    const view = goals.get(agent);
    // The host's GoalService.view() spreads the goal flat, so the phase field is
    // `view.phase` (active | paused | blocked | complete) — there is no nested
    // `view.goal.status`. The older spellings stay as fallbacks so a host that
    // shapes the view differently degrades to "no goal" rather than throwing.
    const status = view?.phase ?? view?.goal?.phase ?? view?.status ?? view?.goal?.status;
    return typeof status === 'string' ? status : undefined;
  } catch {
    return undefined;
  }
}

async function readTitle(ctx, sessionId, fallback) {
  try {
    const query = ctx.get('sessionQuery');
    if (query === undefined || typeof query.readTitle !== 'function') return fallback;
    const snapshot = await query.readTitle(sessionId);
    const title = snapshot?.title;
    return typeof title === 'string' && title.trim() !== '' ? title.trim() : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The assistant's last words, for the notification body.
 *
 * A surface read is preferred because it returns only what the model can
 * currently see instead of replaying a whole log to find one line; a session
 * with no surface yet falls back to the full read. `undefined` rather than an
 * empty string means "nothing to add", which `buildNotification` omits.
 */
async function readLastAssistantText(ctx, sessionId) {
  const query = ctx.get('sessionQuery');
  if (query === undefined) return undefined;
  try {
    if (typeof query.readSurface === 'function') {
      const snapshot = await query.readSurface(sessionId);
      const text = lastAssistantText(snapshot?.events);
      if (text !== undefined) return text;
    }
    if (typeof query.readSession === 'function') {
      const snapshot = await query.readSession(sessionId);
      return lastAssistantText(snapshot?.events);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function lastAssistantText(events) {
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'assistant/message') continue;
    const content = event.data?.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join(' ')
      .trim();
    if (text !== '') return text;
  }
  return undefined;
}

/** A failure's message, for the body of a turn that ended in `error`. */
function failureDetail(reason) {
  const message = reason?.error?.message;
  return typeof message === 'string' ? message.trim() : '';
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
