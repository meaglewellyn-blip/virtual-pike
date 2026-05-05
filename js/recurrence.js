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
    const allDefaults = (data.tasks || []).filter((t) => t.isDefaultDaily && t.isLibrary);
    if (!allDefaults.length) return;

    // Build title → [all lib IDs] map BEFORE dedup so hasInstance() can cross-check
    // every library variant of the same title.  Multiple variants can exist when
    // migrateDailyRhythmsToDefaults() and migrateLegacyRecurrences() both ran, or
    // when a user manually created a second library record with the same name.
    const titleToLibIds = new Map();
    allDefaults.forEach((lib) => {
      const k = (lib.title || '').trim().toLowerCase();
      if (!titleToLibIds.has(k)) titleToLibIds.set(k, []);
      titleToLibIds.get(k).push(lib.id);
    });

    // Canonical library record per title (first encountered wins).
    const seenTitles = new Set();
    const defaults = allDefaults.filter((lib) => {
      const k = (lib.title || '').trim().toLowerCase();
      if (seenTitles.has(k)) return false;
      seenTitles.add(k);
      return true;
    });

    // Does ANY non-library instance for today exist under ANY lib ID that shares
    // this lib's title?  This prevents re-creation when two library records share
    // a title but only one was used as the canonical source for an instance.
    // Completed instances MUST count — excluding them caused the "respawn" bug
    // where completing a daily default spawned a new copy on the next state change.
    function hasInstance(lib, tasks) {
      const relIds = titleToLibIds.get((lib.title || '').trim().toLowerCase()) || [lib.id];
      return tasks.some(
        (t) => !t.isLibrary && t.scheduledDate === today &&
               (relIds.includes(t.librarySourceId) ||
                relIds.some((id) => t.id === `tsk_default_${id}_${today}`))
      );
    }

    // ── Detect what work is needed ───────────────────────────────────────────

    // 1. Same-ID duplicates: the old hasInstance() (which excluded completedAt)
    //    re-pushed the same deterministic ID for a completed task, leaving two
    //    objects with the same id in data.tasks.  Array.find() always hits the
    //    first one — the completed original — so dragging the "active" copy moved
    //    the completed task onto the timeline and left the active copy in the tray.
    const idCounts = new Map();
    (data.tasks || []).forEach((t) => idCounts.set(t.id, (idCounts.get(t.id) || 0) + 1));
    const hasSameIdDups = [...idCounts.values()].some((n) => n > 1);

    // 2. Title-based duplicates: two non-library instances with the same daily-
    //    default title on the same day (different IDs, different librarySourceIds).
    const titleCountsToday = new Map();
    (data.tasks || []).forEach((t) => {
      if (t.isLibrary || t.scheduledDate !== today) return;
      const k = (t.title || '').trim().toLowerCase();
      if (!seenTitles.has(k)) return;
      const relIds = titleToLibIds.get(k) || [];
      if (!relIds.includes(t.librarySourceId) &&
          !relIds.some((id) => t.id === `tsk_default_${id}_${today}`)) return;
      titleCountsToday.set(k, (titleCountsToday.get(k) || 0) + 1);
    });
    const hasTitleDups = [...titleCountsToday.values()].some((n) => n > 1);

    // 3. Missing instance: no instance at all for a canonical default.
    const needsNew = defaults.some((lib) => !hasInstance(lib, data.tasks || []));

    if (!hasSameIdDups && !hasTitleDups && !needsNew) return;

    global.Pike.state.commit((d) => {
      d.tasks = d.tasks || [];

      // ── Step 1: Remove same-ID duplicates ─────────────────────────────────
      // Keep the most-progressed copy per ID:
      //   scheduled + completed > scheduled > completed > active
      const byId = new Map();
      d.tasks.forEach((t) => {
        const prev = byId.get(t.id);
        if (!prev) { byId.set(t.id, t); return; }
        const sN = (t.scheduledStart ? 2 : 0) + (t.completedAt ? 1 : 0);
        const sP = (prev.scheduledStart ? 2 : 0) + (prev.completedAt ? 1 : 0);
        if (sN > sP) byId.set(t.id, t);
      });
      if (byId.size < d.tasks.length) d.tasks = [...byId.values()];

      // ── Step 2: Remove title-based duplicates for today's daily defaults ───
      // Among all non-library instances for today that belong to a managed title,
      // keep only the most-progressed one per title.
      const byTitle = new Map();
      let foundTitleDup = false;
      d.tasks.forEach((t) => {
        if (t.isLibrary || t.scheduledDate !== today) return;
        const k = (t.title || '').trim().toLowerCase();
        if (!seenTitles.has(k)) return;
        const relIds = titleToLibIds.get(k) || [];
        if (!relIds.includes(t.librarySourceId) &&
            !relIds.some((id) => t.id === `tsk_default_${id}_${today}`)) return;
        const prev = byTitle.get(k);
        if (!prev) { byTitle.set(k, t); return; }
        foundTitleDup = true;
        const sN = (t.scheduledStart ? 2 : 0) + (t.completedAt ? 1 : 0);
        const sP = (prev.scheduledStart ? 2 : 0) + (prev.completedAt ? 1 : 0);
        if (sN > sP) byTitle.set(k, t);
      });
      if (foundTitleDup) {
        const keepSet = new Set(byTitle.values());
        d.tasks = d.tasks.filter((t) => {
          if (t.isLibrary || t.scheduledDate !== today) return true;
          const k = (t.title || '').trim().toLowerCase();
          if (!seenTitles.has(k)) return true;
          const relIds = titleToLibIds.get(k) || [];
          if (!relIds.includes(t.librarySourceId) &&
              !relIds.some((id) => t.id === `tsk_default_${id}_${today}`)) return true;
          return keepSet.has(t);
        });
      }

      // ── Step 3: Create missing instances ──────────────────────────────────
      defaults.forEach((lib) => {
        if (!hasInstance(lib, d.tasks)) {
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
    // Exception: tasks whose title matches an existing isDefaultDaily library record
    // are daily default instances converted from the old recurrence engine — preserve them.
    const recIds = new Set(recs.map((r) => r.id));
    const dailyDefaultTitles = new Set(
      (data.tasks || [])
        .filter((t) => t.isDefaultDaily && t.isLibrary)
        .map((t) => (t.title || '').trim().toLowerCase())
    );
    const orphanedTrayIds = new Set(
      (data.tasks || [])
        .filter((t) => {
          if (!t.recurrenceId || recIds.has(t.recurrenceId)) return false;
          if (t.completedAt) return false;
          // Don't prune tasks that correspond to an isDefaultDaily library entry by title
          if (dailyDefaultTitles.has((t.title || '').trim().toLowerCase())) return false;
          return true;
        })
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
