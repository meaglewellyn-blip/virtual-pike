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

  // ── Daily defaults ──────────────────────────────────────────────────────────
  // Tasks with isDefaultDaily:true are pre-populated into today's tray each day.
  // This replaces the old `schedule.type === 'daily'` rhythm pattern.

  function runDailyDefaults() {
    const today = todayKey();
    const data = global.Pike.state.data;
    const defaults = (data.tasks || []).filter((t) => t.isDefaultDaily && t.isLibrary);
    if (!defaults.length) return;

    // Only commit if something is actually missing
    const needsCommit = defaults.some((lib) =>
      !(data.tasks || []).some(
        (t) => t.librarySourceId === lib.id && t.scheduledDate === today && !t.completedAt
      )
    );
    if (!needsCommit) return;

    global.Pike.state.commit((d) => {
      d.tasks = d.tasks || [];
      defaults.forEach((lib) => {
        const exists = d.tasks.some(
          (t) => t.librarySourceId === lib.id && t.scheduledDate === today && !t.completedAt
        );
        if (!exists) {
          d.tasks.push({
            id: `tsk_default_${lib.id}_${today}`,
            title: lib.title,
            estimateMinutes: lib.estimateMinutes || 30,
            scheduledDate: today,
            scheduledStart: null,
            completedAt: null,
            isLibrary: false,
            librarySourceId: lib.id,
            category: lib.category || 'self',
          });
        }
      });
    });
  }

  // One-time migration: moves any rhythm with schedule.type === 'daily' into
  // isDefaultDaily library tasks and removes them from data.rhythms.
  function migrateDailyRhythmsToDefaults() {
    const data = global.Pike.state.data;
    const dailyRhythms = (data.rhythms || []).filter((r) => r.schedule?.type === 'daily');
    if (!dailyRhythms.length) return;  // already migrated

    global.Pike.state.commit((d) => {
      d.tasks = d.tasks || [];
      d.rhythmCompletions = d.rhythmCompletions || {};

      const dailyIds = new Set(dailyRhythms.map((r) => r.id));

      // Create a library entry for each daily rhythm (if not already there)
      dailyRhythms.forEach((r) => {
        const alreadyMigrated = d.tasks.some(
          (t) => t.isDefaultDaily && t.isLibrary && t.title === r.title
        );
        if (!alreadyMigrated) {
          d.tasks.push({
            id: 'lib-daily-' + r.id,
            title: r.title,
            estimateMinutes: r.estimateMinutes || 30,
            scheduledDate: null,
            scheduledStart: null,
            completedAt: null,
            isLibrary: true,
            isDefaultDaily: true,
            category: r.category || 'self',
          });
        }
      });

      // Remove daily rhythms from rhythms array
      d.rhythms = (d.rhythms || []).filter((r) => r.schedule?.type !== 'daily');

      // Remove stale rhythm completion keys for those rhythms
      Object.keys(d.rhythmCompletions).forEach((k) => {
        if ([...dailyIds].some((id) => k.startsWith(id + '::'))) {
          delete d.rhythmCompletions[k];
        }
      });

      // Remove any isRhythmRef tasks tied to the old daily rhythms
      d.tasks = d.tasks.filter(
        (t) => !(t.isRhythmRef && dailyIds.has(t.rhythmId))
      );
    });
  }

  // ── Legacy recurrence migration ─────────────────────────────────────────────
  // The old data model stored repeating tasks in `data.recurrences`. The new
  // model uses two separate systems:
  //   • isDefaultDaily library tasks   (replaces rule.type === 'daily')
  //   • Weekend Rhythm subtasks         (replaces rule.type === 'everyWeekend')
  //
  // This migration runs once (idempotent). It:
  //   1. Converts any daily recurrences → isDefaultDaily library tasks
  //   2. Removes everyWeekend recurrences (superseded by rhythm subtasks)
  //   3. Prunes pending tray tasks generated from removed weekend recurrences
  //      (completed ones are kept as historical record)
  function migrateLegacyRecurrences() {
    const data = global.Pike.state.data;
    const recs = data.recurrences || [];
    const dailyRecs   = recs.filter((r) => r.rule?.type === 'daily');
    const weekendRecs = recs.filter((r) => r.rule?.type === 'everyWeekend');
    // Null-rule ("manual") recurrences are the old Other/library task storage
    const manualRecs  = recs.filter((r) => !r.rule);

    const hasWork = dailyRecs.length || weekendRecs.length || manualRecs.length;

    // Also check for orphaned tray tasks whose recurrenceId no longer has a
    // matching entry in data.recurrences (parent was deleted by an earlier migration).
    const recIds = new Set(recs.map((r) => r.id));
    const orphanedTrayIds = new Set(
      (data.tasks || [])
        .filter((t) => t.recurrenceId && !recIds.has(t.recurrenceId) && !t.completedAt)
        .map((t) => t.id)
    );

    if (!hasWork && orphanedTrayIds.size === 0) return;   // nothing to do

    const weekendIds = new Set(weekendRecs.map((r) => r.id));
    const dailyIds   = new Set(dailyRecs.map((r) => r.id));
    const manualIds  = new Set(manualRecs.map((r) => r.id));

    global.Pike.state.commit((d) => {
      d.tasks       = d.tasks || [];
      d.recurrences = d.recurrences || [];

      // 1. Promote daily recurrences → isDefaultDaily library tasks
      dailyRecs.forEach((r) => {
        const already = d.tasks.some(
          (t) => t.isDefaultDaily && t.isLibrary &&
                 t.title.trim().toLowerCase() === r.title.trim().toLowerCase()
        );
        if (!already) {
          d.tasks.push({
            id:              'lib-daily-rec-' + r.id,
            title:           r.title,
            estimateMinutes: r.estimateMinutes || 30,
            scheduledDate:   null, scheduledStart: null, completedAt: null,
            isLibrary: true, isDefaultDaily: true,
            category: r.category || 'self',
          });
        }
      });

      // 2. Promote manual (null-rule) recurrences → isLibrary task library entries
      //    These are the "Other" tasks that lived in the old recurrence store.
      manualRecs.forEach((r) => {
        const already = d.tasks.some(
          (t) => t.isLibrary && !t.isDefaultDaily &&
                 t.title.trim().toLowerCase() === r.title.trim().toLowerCase()
        );
        if (!already) {
          d.tasks.push({
            id:              'lib-other-rec-' + r.id,
            title:           r.title,
            estimateMinutes: r.estimateMinutes || 30,
            scheduledDate:   null, scheduledStart: null, completedAt: null,
            isLibrary: true, isDefaultDaily: false,
            category: r.category || 'home',
          });
        }
      });

      // 3. Remove migrated recurrences from the array
      d.recurrences = d.recurrences.filter(
        (r) => !dailyIds.has(r.id) && !weekendIds.has(r.id) && !manualIds.has(r.id)
      );

      // 4. Prune pending tray tasks generated from old everyWeekend recurrences
      d.tasks = d.tasks.filter((t) => {
        if (!t.recurrenceId || !weekendIds.has(t.recurrenceId)) return true;
        return !!t.completedAt;
      });

      // 5. Prune orphaned tray tasks — unfinished tasks whose parent recurrence
      //    was already removed by a prior migration run. Completed ones are kept.
      d.tasks = d.tasks.filter((t) => !orphanedTrayIds.has(t.id));
    });
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
  global.Pike.recurrence = { run, matchesToday, manualRecurrences, quickAddFromLibrary, runDailyDefaults, migrateDailyRhythmsToDefaults, migrateLegacyRecurrences };
})(window);
