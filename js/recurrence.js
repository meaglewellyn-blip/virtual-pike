/* Virtual Pike — recurrence engine
 *
 * Reads `data.recurrences` and generates today's tasks based on each rule.
 *
 * Rules supported in v1:
 *   { type: 'everyWeekend' }   fires on Sat or Sun, deduped per weekend
 *   { type: 'daily' }          fires every day, deduped per day
 *   null                       manual — never auto-fires (lives in library only)
 *
 * Idempotency: each recurrence carries `lastGeneratedFor` (a cycle key).
 * If the cycle key matches the current cycle, generation is skipped.
 *
 *   Pike.recurrence.run()           — run once now
 *   Pike.recurrence.matchesToday(r) — boolean: would this fire today?
 */

(function (global) {
  'use strict';

  let running = false;

  function pad2(n) { return String(n).padStart(2, '0'); }

  function dateKey(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function todayKey() { return dateKey(new Date()); }

  // The "weekend cycle key" is the Saturday of the current week (so both Sat
  // and Sun map to the same key, and a recurrence fires only once per weekend).
  function weekendKey(d = new Date()) {
    const day = d.getDay(); // 0 Sun, 6 Sat
    const sat = new Date(d);
    if (day === 0)      sat.setDate(d.getDate() - 1);   // Sunday → previous Saturday
    else if (day === 6) sat.setDate(d.getDate());       // Saturday → today
    else return null;                                   // weekday → not in a weekend
    return dateKey(sat);
  }

  function isWeekend(d = new Date()) {
    const day = d.getDay();
    return day === 0 || day === 6;
  }

  function cycleKeyFor(rule) {
    if (!rule) return null;
    if (rule.type === 'daily') return todayKey();
    if (rule.type === 'everyWeekend') return weekendKey(new Date());
    return null;
  }

  function matchesToday(r) {
    if (!r || !r.rule) return false;
    if (r.rule.type === 'daily') return true;
    if (r.rule.type === 'everyWeekend') return isWeekend();
    return false;
  }

  function newTaskFromRecurrence(r, cycleKey, today) {
    return {
      id:              `tsk_${r.id}_${cycleKey}`,
      title:           r.title,
      estimateMinutes: r.estimateMinutes || 30,
      scheduledDate:   today,
      scheduledStart:  null,
      completedAt:     null,
      recurrenceId:    r.id,
      category:        r.category || 'self',
    };
  }

  function run() {
    if (running) return { generated: 0 };
    running = true;
    let generated = 0;
    try {
      const today = todayKey();
      const data = global.Pike.state.data;
      const recurrences = data.recurrences || [];
      if (recurrences.length === 0) return { generated: 0 };

      let mutated = false;
      global.Pike.state.commit((d) => {
        d.tasks = d.tasks || [];
        const recList = d.recurrences || [];
        for (const r of recList) {
          if (!matchesToday(r)) continue;
          const cycle = cycleKeyFor(r.rule);
          if (!cycle) continue;
          if (r.lastGeneratedFor === cycle) continue;

          // Dedupe: if a task with this recurrenceId already exists for today, skip creation
          const exists = d.tasks.some((t) => t.recurrenceId === r.id && t.scheduledDate === today);
          if (!exists) {
            d.tasks.push(newTaskFromRecurrence(r, cycle, today));
            generated += 1;
          }
          r.lastGeneratedFor = cycle;
          mutated = true;
        }
        if (!mutated) {
          // No-op commit guard: throw a sentinel to abort if nothing changed.
          // (state.commit doesn't support abort, so we just leave d as-is.)
        }
      });
      return { generated };
    } finally {
      running = false;
    }
  }

  function manualRecurrences() {
    return (global.Pike.state.data.recurrences || []).filter((r) => !r.rule);
  }

  function quickAddFromLibrary(recurrenceId) {
    const r = (global.Pike.state.data.recurrences || []).find((x) => x.id === recurrenceId);
    if (!r) return false;
    const today = todayKey();
    global.Pike.state.commit((d) => {
      d.tasks = d.tasks || [];
      // Always create a fresh instance (allows multiple of the same template per day if desired)
      const id = `tsk_${r.id}_${today}_${Date.now().toString(36)}`;
      d.tasks.push({
        id,
        title:           r.title,
        estimateMinutes: r.estimateMinutes || 30,
        scheduledDate:   today,
        scheduledStart:  null,
        completedAt:     null,
        recurrenceId:    r.id,
        category:        r.category || 'self',
      });
    });
    return true;
  }

  global.Pike = global.Pike || {};
  global.Pike.recurrence = { run, matchesToday, manualRecurrences, quickAddFromLibrary };
})(window);
