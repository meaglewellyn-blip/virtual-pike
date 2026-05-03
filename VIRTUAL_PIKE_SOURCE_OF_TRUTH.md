# Virtual Pike — Source of Truth

**Version:** Based on live codebase as of 2026-05-03 (service worker `pike-v19`)  
**Purpose:** Canonical behavioral, architectural, and diagnostic reference for the live app. Use this document before touching any code or diagnosing any bug.

---

## Table of Contents

- [A. Product Overview](#a-product-overview)
- [B. Today View Logic](#b-today-view-logic)
- [C. Task Architecture — The Three-Bucket Model](#c-task-architecture--the-three-bucket-model)
- [D. Week View + Week Review Logic](#d-week-view--week-review-logic)
- [E. Sync / Persistence / Auth Model](#e-sync--persistence--auth-model)
- [F. Mobile / Desktop Interaction Rules](#f-mobile--desktop-interaction-rules)
- [Section 1: Today](#section-1-today)
- [Section 2: Week](#section-2-week)
- [Section 3: Rhythms](#section-3-rhythms)
- [Section 4: Tasks](#section-4-tasks)
- [Section 5: Travel / Trip Planner](#section-5-travel--trip-planner)
- [Section 6: People / Sponsees](#section-6-people--sponsees)
- [Section 7: Brain Dump](#section-7-brain-dump)
- [Section 8: Quotes](#section-8-quotes)
- [Section 9: Settings / Sync / Auth](#section-9-settings--sync--auth)
- [G. Known Regression Traps](#g-known-regression-traps)
- [H. Diagnostic Checklist](#h-diagnostic-checklist)
- [I. Non-Negotiable Invariants](#i-non-negotiable-invariants)

---

## A. Product Overview

### What Pike Is

Virtual Pike is a personal operating system — a single-screen daily cockpit for one person (Meagan). It is not a productivity app. It is not a to-do list. It is a calm, private place to hold the day, week, routines, travel, relationships, ideas, and inspiration that would otherwise live across five different tools and her head.

Design philosophy: **minimal, warm, editorial, Four Seasons–calm**. Never crowded. Never urgent-looking. Everything has a home; nothing competes for attention.

### Navigation

Nine sections, hash-based routing (`#today`, `#week`, etc.):
1. **Today** — the cockpit. Default landing screen.
2. **Week** — Mon–Sun calendar grid + weekly review.
3. **Rhythms** — workout sequence + recurring routines.
4. **Travel** — trip planner, packing, supplements, pre-trip checklists.
5. **People** — sponsees (step work, 7-day cadence) + family + friends.
6. **Brain Dump** — free-capture parking lot for ideas.
7. **Tasks** — three-bucket library view (Weekend Rhythm / Daily Defaults / Other).
8. **Quotes** — quote library + daily quote surfaced in Today.
9. **Settings** — Google Calendar connections + hardcoded defaults.

### Architecture

| Layer | Choice |
|---|---|
| Frontend | Plain HTML + vanilla JS (no framework, no build step) |
| Data | Single Supabase row — `app_state` table, `id = 'meagan'`, `data` column is JSONB |
| Sync | localStorage cache → debounced Supabase push (600ms) → realtime subscribe |
| Auth | SHA-256 client-side passphrase gate; session unlocked in `sessionStorage` |
| Hosting | GitHub Pages (`meaglewellyn-blip/virtual-pike`) |
| PWA | `manifest.json` + service worker (network-first, offline shell) |
| Weather | Open-Meteo API (free, no key) |
| Calendar | Google Calendar via Supabase Edge Function OAuth proxy |

All JS modules follow the IIFE pattern: `(function(global){...})(window)`. They attach to `window.Pike.*`. Loading order defined in `index.html` matters: `auth → state → router → db → modal → recurrence → today → week → rhythms → travel → people → tasks → braindump → quotes → gcal → weather → app`.

---

## B. Today View Logic

### Timeline Planner

- **Rendered by:** `js/today.js` → `renderTimeline()`
- **Time range:** `settings.dayStart` → `settings.dayEnd` (default 05:00–23:00). Each hour row is 64px tall (`HOUR_HEIGHT_PX`). CSS variable `--hour-h` must match.
- **Half-hour guide marks:** Rendered by `::after` pseudo-element on `.tl-hour-row`. These are dashed lines at the half-hour point within each row. They use `--line` color at 0.7 opacity (changed from `--line-soft` at 0.5 — the old values were invisible against the warm ivory background).
- **Now-line:** A `.tl-now` element pinned to `top: minutesToPx(nowMin)`. It updates every 60 seconds via `setInterval(tick, 60_000)` in `app.js` and also when the tab becomes visible again.
- **Workday-start marker:** A `.tl-workstart` element. On weekdays, uses `settings.defaultWorkdayStart` unless `dailyOverrides[YYYY-MM-DD].workdayStart` is set. On weekends: only shows if an explicit override exists.
- **Three kinds of blocks on the timeline:**
  1. **Event blocks** (`.tl-block-event`): from `data.events`, manually entered. Clickable → edit modal. Draggable for rescheduling. Source: `manual`.
  2. **Google Calendar blocks** (`.tl-block-gcal`): from `data.calendarEvents`. Read-only — no click-to-edit, no drag. Show source badge (Personal/Work).
  3. **Scheduled task blocks** (`.tl-block-task`): tasks with `scheduledDate === todayKey()` AND `scheduledStart !== null`. Clickable → edit modal. Draggable for rescheduling.
- **Empty hint:** Only shown when zero blocks exist on the timeline.

### Flexible Tray

- **Rendered by:** `js/today.js` → `renderTray()`
- **Shows:** tasks where `scheduledDate === todayKey()` AND `scheduledStart === null` AND `completedAt === null`.
- **Does NOT show:** library tasks (`isLibrary: true`). Library tasks never directly appear in the tray — only their daily instances do.
- **Drag-to-schedule:** Dragging a tray item onto the timeline calls `scheduleTaskAt(taskId, snappedMinutes)` — sets `scheduledStart`, keeps `scheduledDate`.
- **Move to tray:** Clicking "Move to tray" in the task edit modal sets `scheduledStart = null`, keeping `scheduledDate` — task stays in Today but moves back to Flexible tray.
- **Empty state:** "No flexible tasks yet. Tap **+ Task** to capture one." (only when tray is empty)

### Weekend Rhythm Section

- **Rendered by:** `js/today.js` → `renderTodayRhythms()`
- **Shows:** All active rhythms that match today's day of week — `weekdays` (Mon–Fri), `weekends` (Sat–Sun), `weekly` (specific day). **Does NOT show `daily` rhythms** — those were migrated to Daily Default tasks.
- **Position in DOM:** Appended to `.today-timeline-wrap` after the timeline (not inside it). Rebuilt from scratch on every `render()`.
- **For rhythms WITH subtasks (Weekend Routine):**
  - If `weekendAllocations[isoWeek]` exists: shows only subtasks allocated to today's day (`saturday`/`sunday`), each with a ✓ button and `→` schedule button. Done subtasks are shown struck-through with filled circle.
  - If no allocation yet: shows a single "Plan [Rhythm name]" nudge button that opens `openPlanWeekendModal(rhythm)`.
- **For rhythms WITHOUT subtasks (atomic):** Shows the rhythm with ✓ button and `→` schedule button. Done rhythms are hidden from the list.
- **✓ button:** Calls `markSubtaskDone(rhythmId, subtaskId, today)` or `markRhythmDone(rhythmId, today)`. Writes to `rhythmCompletions`.
- **→ schedule button (`.today-rhythm-sched-btn`):** Always visible at `opacity: 0.5`, upgrades to `opacity: 1` on hover. On click, opens `openRhythmScheduleModal(rhythmRef)` — a time-picker modal. On submit, calls `scheduleRhythmRefAt(ref, startMinutes)`.
- **Drag-to-schedule:** `li.draggable = true`. `dragstart` sets `e.dataTransfer` payload `{ rhythmRef: { rhythmId, subtaskId, title, estimateMinutes } }`. Drop on `#today-timeline` calls `scheduleRhythmRefAt()`.

### scheduleRhythmRefAt()

When a rhythm item is scheduled (by drag or by tap → modal), it creates a task in `data.tasks` with these flags:
```js
{
  isRhythmRef: true,
  rhythmId: '...',
  subtaskId: '...' | null,
  scheduledDate: todayKey(),
  scheduledStart: 'HH:MM',
}
```
If a task with the same `rhythmId` + `subtaskId` + `scheduledDate` already exists, it updates `scheduledStart` instead of creating a duplicate.

**Completing a rhythm-linked task:** When marking such a task complete in the edit modal, `today.js` also calls `markSubtaskDone(rhythmId, subtaskId, dateObj)` or `markRhythmDone(rhythmId, dateObj)` so the rhythm checklist reflects the completion too. This is the completion bridge between the planner and the rhythm layer.

### Planner Items vs Tray Items vs Rhythm-linked Items

| Type | `isRhythmRef` | `isLibrary` | `isDefaultDaily` | `scheduledStart` | Appears in |
|---|---|---|---|---|---|
| Tray task (ad hoc) | false | false | false | null | Flexible tray |
| Tray task (daily default instance) | false | false | false | null | Flexible tray |
| Scheduled tray task | false | false | false | set | Timeline |
| Rhythm-linked planner task | true | false | false | set | Timeline |
| Library task | false | true | false | null | Tasks section only |
| Daily default library | false | true | true | null | Tasks section only |

---

## C. Task Architecture — The Three-Bucket Model

The Tasks section renders three distinct groups. **These must never be conflated.**

### Bucket 1: Weekend Rhythm

- **What it is:** The subtasks belonging to any active weekend rhythm (`schedule.type === 'weekends'` with `subtasks` array). Shown as a read-only reference list.
- **Where data lives:** `data.rhythms[*].subtasks[]` — NOT in `data.tasks`.
- **Who owns it:** The Rhythms module. Tasks section renders it read-only. The "Edit subtasks in Rhythms" hint is always shown.
- **Cannot be added/edited from the Tasks section.** Add subtasks via Rhythms → Edit rhythm.
- **CRUD path:** Rhythms module → `openRhythmModal(existing)` → subtask editor.
- **What it is NOT:** These are not library tasks. They never appear in `data.tasks` until a user actively schedules one onto the Today timeline via `scheduleRhythmRefAt()`.

### Bucket 2: Daily Defaults

- **What it is:** Tasks that auto-populate in the Flexible tray every day, without any action required.
- **Where data lives:** `data.tasks` records with `isLibrary: true` AND `isDefaultDaily: true`. These are the template records (no `scheduledDate`, no `scheduledStart`).
- **How they appear in Today:** `recurrence.runDailyDefaults()` runs on every boot and every state change. For each `isDefaultDaily` library record, it checks if an instance already exists today (`librarySourceId === lib.id AND scheduledDate === today AND !completedAt`). If not, it creates one. The created instance has `isLibrary: false`, `librarySourceId: lib.id`, `scheduledDate: today`, `scheduledStart: null`.
- **Completing one:** Marks `completedAt` on the instance. The library record is unaffected. Tomorrow a new instance is created.
- **CRUD path:** Tasks section → Daily Defaults → `openDailyDefaultModal()`.
- **What it is NOT:** A rhythm. No rhythm completion tracking. No cadence. No dot. Just "always there in the tray."

### Bucket 3: Other (Task Library)

- **What it is:** Tasks saved to the library for on-demand use. Not auto-added to today.
- **Where data lives:** `data.tasks` records with `isLibrary: true` AND `isDefaultDaily: false` (or missing).
- **Adding to today:** "Add to today" button → choice modal → "Add to planner" (prompts for a time, creates scheduled instance) or "Add to Today dock" (creates unscheduled tray instance). Duplicate guard: if an active instance already exists today, shows "Already in Today" flash.
- **CRUD path:** Tasks section → Other → `openOtherTaskModal()`.
- **What it is NOT:** Daily defaults. Adding to "Other" means nothing happens automatically — user must manually pull it into Today.

### Key State Flags on Task Records

| Flag | Meaning |
|---|---|
| `isLibrary: true` | A template record. Never directly shown in the tray/timeline. |
| `isDefaultDaily: true` | Auto-populated into the tray every day (requires `isLibrary: true`). |
| `isRhythmRef: true` | Created by `scheduleRhythmRefAt()`. Bridges rhythm completion tracking. |
| `librarySourceId: '...'` | Links a tray instance back to its library source for duplicate checking. |
| `scheduledDate: 'YYYY-MM-DD'` | The day this task belongs to. |
| `scheduledStart: 'HH:MM'` | If set, task is on the timeline. If null, task is in the Flexible tray. |
| `completedAt: ISO string` | Task done. Tray hides it. Timeline shows strikethrough. |
| `recurrenceId: '...'` | Legacy field. Used by old `data.recurrences` engine (now mostly migrated away). |

---

## D. Week View + Week Review Logic

### What Appears in Week View

The week grid (`js/week.js`) renders Mon–Sun for the current (or offset) week. For each day, in this order:

1. **Google Calendar all-day events** — from `data.calendarEvents` where `isAllDay: true`. Shows source badge (Personal/Work).
2. **Manual events** — from `data.events` where `date === dayKey`. Clickable → `openEventModal()`.
3. **Google Calendar timed events** — from `data.calendarEvents` where `!isAllDay && start` is set.
4. **Scheduled tasks** — from `data.tasks` where `scheduledDate === dayKey AND scheduledStart AND !completedAt`. Shows scheduled time.
5. **Rhythms** — see detailed logic below.
6. **Trip departure markers** — `✈ [trip name]` for any trip where `departureDate === dayKey`.
7. **Empty state:** "Open" (plain text) when nothing else renders.

### Rhythm Rendering in Week View (`rhythmsForDay()`)

For each active rhythm matching the day's schedule:
- **Atomic rhythm (no subtasks):** If not done this period → shows with ✓ button. If done → hidden entirely.
- **Weekend rhythm with subtasks:**
  - If `weekendAllocations[isoWeek]` exists: shows only **undone** allocated subtasks for that specific day (Sat or Sun), each with ✓ button. Subtask items carry `data-subtask-id`.
  - If no allocation: shows a single "nudge" entry: `[Rhythm title] — tap to plan` with `is-rhythm-unplanned` class. Clicking opens `openPlanWeekendModal(rhythm)`.

### What Should NOT Appear in Week View

- Completed tasks (`completedAt` is set).
- Library/template records (`isLibrary: true`).
- Done rhythms (filtered out by `isRhythmDoneThisPeriod()`).
- Tray tasks without `scheduledStart`.

### Week Review — `generateWeeklyReview(weekDates)`

Generates an array of plain-English sentence strings. Each string is a complete grammatical sentence. **Never emit a partial fragment.** If the condition that would produce a sentence is not met, skip it entirely.

**Six categories of review lines (in order):**

1. **Workouts** — from `data.workoutSequence.history`. Filtered to `completedAt[0:10]` within the week range.
   - 1 workout: `"You got your workout in — [type]."`
   - 2–4 workouts: `"You trained [N times] — [and-list of types]."`
   - 5+: `"You trained [N] times this week."`
   - 0: nothing.

2. **People / Sponsees** — from `data.people`, filtered by `contactLog` entries within the week range.
   - Sponsees only: `"You connected with your sponsee — [Name]."` / `"You connected with your 3 sponsees — [list]."`
   - Mixed sponsees + others: `"You stayed close to your people this week — [full list]."`
   - Non-sponsees only, 1: `"You stayed in touch with [Name] this week."`
   - Non-sponsees only, 2+: `"You connected with [list] this week."`
   - **Always use "sponsee" / "sponsees" for `category === 'sponsee'` people.** Never substitute "friend" or "person."
   - 0: nothing.

3. **Weekend rhythm completions** — from `rhythmCompletions` and `weekendAllocations` for each `weekends`-type rhythm with subtasks.
   - States per subtask: `done` (key in rhythmCompletions = true), `skipped` (allocation[subId] === null), `allocated-not-done` (allocation[subId] is sat/sun but no completion key), `untouched` (no allocation, no completion).
   - Only emit a line if at least one subtask was intentionally touched (done OR skipped OR allocated).
   - Exact wording rules: see code in `week.js` `generateWeeklyReview()` lines 314–333. Do not paraphrase.

4. **Daily anchor completions** — `isDefaultDaily` tasks completed this week. Groups unique titles.
   - 1 unique: `"[Title] was your steady anchor this week."`
   - 2–4 unique: `"[list] were your anchors this week."`
   - 5+: `"Your daily anchors held — [N] habits showed up this week."`
   - 0: nothing.

5. **Other weekly routines** — atomic (non-subtask) rhythms with a non-weekend schedule that have `rhythmCompletions[r.id + '::' + isoWeek] === true`.
   - 1: `"You kept up with [title] this week."`
   - 2–3: `"You kept up with [list]."`
   - 4+: `"You kept [N] regular routines going this week."`
   - 0: nothing.

6. **Trip prep** — any trip with `checklist3Day` or `checklistNight` items checked.
   - `"[Trip name] prep is moving — [N] item[s] checked off."`

**Empty state:** If `lines.length === 0`, render: `"Nothing tracked yet this week — check back after you've logged some activity."`

### ISO Week Key

All rhythm completion keys use ISO week numbering. The `getISOWeekKey(date)` function in `rhythms.js` is the single source of truth. Week anchor is **Thursday** (ISO 8601). A Saturday and the following Sunday share the same ISO week key. This means a rhythm completed on Saturday and one completed on Sunday of the same weekend map to the same key.

---

## E. Sync / Persistence / Auth Model

### The Three Storage Layers

| Store | Key | What lives there | Expires |
|---|---|---|---|
| `localStorage` | `pike.app_state.v1` | The entire state blob (all sections) | Never (manual clear only) |
| `localStorage` | `pike.sync.last_at` | Last Supabase `updated_at` this device synced | Never |
| `sessionStorage` | `pike.auth.unlocked.v1` | Auth unlock flag | When tab/app closes |

### localStorage: `pike.app_state.v1`

Written by `state.saveToLocal()` on every `commit()` and `replace()`. Read on page load to hydrate `state.data`. This means the app is fully functional offline after first load. **Never write to `pike.app_state.v1` directly — only through `state.commit()` or `state.replace()`.**

### sessionStorage: `pike.auth.unlocked.v1`

- Set to `'1'` by `markUnlocked()` when passphrase is correct.
- Cleared by `lock()` or when the tab/app closes.
- **Why sessionStorage:** Pike should reprompt for the passphrase every fresh open (same pattern as Triage). Using localStorage would persist the unlock indefinitely.

### Supabase: `app_state` Table

Single row, `id = 'meagan'`, `data` JSONB, `updated_at` timestamp (server-generated on every upsert).

**Push flow:** `state.commit()` → calls `db.schedulePush(data)` → debounced 600ms → `push(data)` → `client.from('app_state').upsert({ id, data, updated_at: pushedAt })`. On success: stores `pushedAt` in `localStorage['pike.sync.last_at']`.

**Pull flow (on boot):** `pullOnce()` → fetches `data, updated_at` → compares `data.updated_at` against `localStorage['pike.sync.last_at']`. If remote `updated_at <= lastAt`: skip (device already has this or newer data). If remote is newer: `state.replace(data.data)`, then write `updated_at` to `localStorage['pike.sync.last_at']`.

**Why `updated_at` instead of wall clocks:** All devices share the same Supabase clock. Per-device `Date.now()` is independent — Chrome at 9 AM always has a higher epoch than a phone session from 7 AM. Using wall clocks caused Chrome to always skip pulling phone data. Using server `updated_at` gives one authoritative clock.

**Realtime subscription:** Listens to `postgres_changes` on `app_state` for `id = 'meagan'`. Guards:
1. If `incoming JSON === lastPushedJson`: skip (echo of our own push).
2. If `payload.new.updated_at <= lastPushedAt`: skip (stale broadcast).
3. If `Date.now() - state.lastLocalCommitAt < 10000`: skip (user has unsaved in-flight edits).
If all guards pass: `state.replace(payload.new.data)`.

### Same-Device Reopen vs Cross-Device Sync

| Scenario | What happens |
|---|---|
| Same device, same tab — reload | State from `localStorage['pike.app_state.v1']`. `pullOnce` may overwrite if Supabase is newer. |
| Same device, fresh tab — closed and reopened | sessionStorage cleared → passphrase prompt. localStorage state loaded. `pullOnce` runs. |
| Different device — first open | sessionStorage empty → passphrase prompt. localStorage may be cold (empty). `pullOnce` hydrates from Supabase. |
| Different device — after edits on another device | `pullOnce` sees `remoteAt > lastAt` → `state.replace()` brings in the remote state. |

### Sync Indicator (Sidebar Footer)

Three states: `local` (grey dot, "Local only"), `syncing` (animated dot, "Syncing…"), `online` (green dot, "Synced"). Driven by `pike:syncmode` custom events dispatched by `db.js`.

### Auth Gate

SHA-256 hash of passphrase is hardcoded in `js/auth.js` as `PIKE_PASSWORD_HASH`. The plaintext passphrase is never stored anywhere. Hash check: `sha256(input.trim()) === PIKE_PASSWORD_HASH`. On success: `sessionStorage.setItem(SESSION_KEY, '1')`, `document.body.classList.remove('pike-locked')`, dispatches `pike:unlock`. The body has `class="pike-locked"` by default in HTML; the gate overlay is visible when this class is present.

---

## F. Mobile / Desktop Interaction Rules

### No Hover-Only Critical Actions on Mobile

Touch devices have no hover state. Any action that is the **only** way to trigger a behavior must be always-visible, not hover-revealed. Violations of this rule make features completely inaccessible on mobile.

**Current correct behavior:** `.today-rhythm-sched-btn` is `opacity: 0.5` (always visible, always tappable). It upgrades to `opacity: 1` on `:hover` for desktop polish. This was fixed in `today.css v6`.

**Rule:** Never set `opacity: 0` on interactive elements in Today's rhythm section, task tray, or any touch-first control. Hover reveals are acceptable as a *polish upgrade*, never as the *sole access point*.

### Drag vs Tap Affordances

| Action | Desktop | Mobile |
|---|---|---|
| Schedule tray task onto timeline | Drag from tray → drop on timeline | Not supported (HTML5 drag/drop doesn't work on iOS/touch) |
| Schedule rhythm item onto timeline | Drag list item OR tap `→` button | Tap `→` button only |
| Reschedule existing timeline block | Drag the block to new position | Not supported |
| Open event/task modal | Click the block | Tap the block |
| Mark rhythm done | Click ✓ button | Tap ✓ button |

**iOS limitation:** HTML5 `dragstart`/`drop` events do not fire on iOS Safari or mobile Chrome. All critical scheduling actions must have a tap-based fallback. The `→` schedule button exists precisely for this reason.

### Touch-Safe Sizing

Buttons and interactive elements should be at minimum 44×44pt touch target (Apple HIG). The ✓ and → buttons in Today's rhythm section use `padding: var(--space-1) var(--space-2)` — verify these remain comfortably tappable on a real device.

### Mobile-Specific Expectations

- PWA install via Safari → Share → "Add to Home Screen": app opens fullscreen, no browser chrome.
- Auth reprompts on every fresh open (sessionStorage cleared when app closes on iOS).
- Timeline scrolls vertically. The hour rows and blocks scroll within the `.today-timeline` container.
- The Flexible tray is a right-rail on desktop; on mobile it stacks below the timeline.

---

## Section 1: Today

### Purpose

The primary cockpit. What Meagan opens every morning. Shows the day holistically: current time, workday context, weather, a quote, people events, trip prep, the hourly timeline, the flexible task tray, and today's applicable rhythms.

**Not for:** browsing historical data, editing travel templates, managing the task library.

### Owned Data

- `data.events` — manual calendar events (filtered to today's date)
- `data.calendarEvents` — Google Calendar events (read-only, filtered to today)
- `data.tasks` — today's scheduled tasks (both tray and timeline instances)
- `data.rhythms` — filtered to today's applicable rhythms
- `data.rhythmCompletions` — read/write for rhythm and subtask completions
- `data.dailyOverrides[YYYY-MM-DD]` — today's workday start time override
- `data.settings.defaultWorkdayStart` — fallback workday time
- `data.settings.dayStart`, `data.settings.dayEnd` — timeline window
- `data.trips` — read-only for trip prep card
- `data.people` — read-only for upcoming birthdays/anniversaries (via People module)
- `data.quotes` — read-only for daily quote card (via Quotes module)

### Intended Behavior

**Morning anchor card:**
- Shows greeting (time-of-day aware: "Good morning" / "Good afternoon" / "Good evening" / "Late night" / "Quiet night"), current date, current time (updates every minute).
- Shows workday start time and countdown (or "X ago") if set.
- On weekends with no override: "It's [Saturday/Sunday] — open hours, no workday on the books."
- The `<input type="time">` for workday start saves to `data.dailyOverrides[YYYY-MM-DD].workdayStart` on `change`.
- Weekend label changes to "Working today? Set a start time" when no override exists.

**Weather strip:** Hidden until weather data loads. Shows current conditions and hourly precipitation.

**Quote card:** One quote per session (picked randomly on first open, index stored in `sessionStorage`). The same quote shows all day. Adding/deleting a quote clears the session index so the next open re-picks.

**People events:** Birthday/sobriety anniversaries within 14 days. Rendered by `Pike.people.renderUpcomingEvents()`.

**Trip prep card:** Shown when the most imminent upcoming trip departs 1–3 days away (3-day checklist) or 0–1 day away (night-before checklist). Checks sync directly to `trip.checklist3Day` / `trip.checklistNight` in state.

**Timeline:** See [Section B](#b-today-view-logic).

**Flexible tray:** See [Section B](#b-today-view-logic).

**Rhythm section:** See [Section B](#b-today-view-logic).

### Cross-Section Interactions

- Trip prep sourced from Travel module's `renderTripPrepForToday()` (called by `today.js render()`).
- People events sourced from People module's `renderUpcomingEvents()` (called on every People render, which runs on every state change).
- Quote sourced from Quotes module.
- Rhythm items in Today, when scheduled, create tasks in `data.tasks` that show in Week view if they have `scheduledStart`.
- Completing rhythm-linked planner tasks also writes to `rhythmCompletions` (the completion bridge).
- Daily default tasks in the tray are created by `recurrence.runDailyDefaults()` from library records in Tasks.

### Edge Cases

- **No tasks in tray:** Show "No flexible tasks yet. Tap **+ Task** to capture one."
- **No timeline blocks:** Show "Nothing scheduled. Tap **+ Event** to add one, or drag a task in from the right."
- **Weekend, no workday override:** The workday start input label changes; no `.tl-workstart` marker appears on the timeline.
- **Now-line outside timeline window:** Not rendered (guard: `nowMin >= startMin && nowMin <= endMin`).

---

## Section 2: Week

### Purpose

Seven-day view for context and planning. Shows what's on the calendar, what rhythms are due, and departure dates for trips. Also home of "This Week in Review."

**Not for:** detailed task management, rhythm editing, trip details.

### Owned Data

- `data.events`, `data.calendarEvents` — filtered per day
- `data.tasks` — only scheduled (`scheduledStart` set) and incomplete tasks
- `data.rhythms` + `data.rhythmCompletions` — per-day rendering
- `data.trips` — departure date markers
- Module state: `weekOffset` (integer, Mon–Sun week offset from current)

### Intended Behavior

- Navigation: `‹` / `›` buttons offset `weekOffset` by ±1. "This Week in Review" button in header toggles the review card.
- Each day column: header shows short day name + date + "+ Event" button. Body shows items in the order listed in [Section D](#d-week-view--week-review-logic).
- Clicking a manual event opens `openEventModal(ev)` for editing.
- Clicking "— tap to plan" nudge opens `openPlanWeekendModal(rhythm)`.
- Clicking ✓ on a rhythm item calls `markRhythmDone` or `markSubtaskDone`. State change → re-render automatically via `app.js` listener.
- "+ Event" on any day opens the event modal pre-filled with that day's date.

### Edge Cases / Wording

- **Day with nothing:** Show `<p class="week-day-empty">Open</p>` — not blank, not an empty string.
- **Done rhythms:** Never show. Filtered by `isRhythmDoneThisPeriod()`.
- **Past days:** Get `.is-past` CSS class (faded appearance). Today gets `.is-today`.

---

## Section 3: Rhythms

### Purpose

Two distinct features under one section:
1. **Workout sequence** — a rotating 4-day split shown as "next workout" with exercise list. Mark complete → advances pointer. Skip → advances pointer without recording history.
2. **Weekly routines** — rhythm CRUD, including the Weekend Routine with subtask allocation.

**Not for:** daily habits (those are Daily Defaults in Tasks). Not for viewing today's rhythm status (that's Today).

### Owned Data

- `data.workoutSequence` — `{ order: [...], nextIndex: N, history: [...] }`
- `data.rhythms` — array of rhythm objects
- `data.rhythmCompletions` — completion tracking

### Workout Sequence

- `WORKOUT_ORDER` (hardcoded in `rhythms.js`): Shoulders/Back → Glutes/Hams → Chest/Bicep/Triceps → Legs/Abs. 4-day cycle.
- Cardio finisher: "15–20 min cardio (jog, elliptical, stair master)" — shown as optional on every workout card.
- "Mark complete" → writes to `workoutSequence.history` with `type` (the workout ID) and `completedAt` (ISO timestamp). Advances `nextIndex`.
- "Skip →" → advances `nextIndex` only, no history entry.
- **The dots:** 4 dots showing current position in the sequence.

### Weekly Routines

- Rhythm schedules: `weekly` (specific day), `daily` (⚠️ MIGRATED AWAY — see below), `weekdays`, `weekends`.
- **Daily rhythms have been migrated away.** Any rhythm with `schedule.type === 'daily'` gets migrated by `recurrence.migrateDailyRhythmsToDefaults()` into a `isDefaultDaily` library task. After migration, it no longer appears in the Rhythms section.
- **Weekend Rhythm subtasks:** Subtasks are stored as `rhythm.subtasks[]`. Weekend allocation for the current ISO week stored in `rhythm.weekendAllocations[isoWeek]`. Each subtask per week can be: `'saturday'`, `'sunday'`, or `null` (skip).
- **"Plan weekend" button:** Appears on rhythm cards that have `subtasks` and `schedule.type === 'weekends'`. Opens `openPlanWeekendModal(rhythm)`.
- **Completion keys:**
  - Atomic rhythm: `rhythmCompletions[rhythmId + '::' + isoWeek]`
  - Subtask: `rhythmCompletions[rhythmId + '::' + subtaskId + '::' + isoWeek]`
  - Daily (before migration): `rhythmCompletions[rhythmId + '::' + YYYY-MM-DD]`

### One-Time Seed

On first boot (or if no `weekends`-type rhythm exists), `rhythms.init()` creates the "Weekend Routine" with 12 subtasks from `WEEKEND_RHYTHM_SUBTASKS`:  
Shower, Wash Hair, Dry Hair, Vacuum, Tidy Up, Brush Ro, Order Groceries, Wash Clothes, Fold Clothes, Clean Kitchen, Clean Bathroom, Review Finances.

---

## Section 4: Tasks

### Purpose

The task library. Three buckets for managing what tasks exist in the system. This is the management surface, not the action surface — you don't complete tasks here.

**Not for:** scheduling tasks onto Today, marking tasks done, viewing completion history.

### Owned Data

- `data.tasks` — all records with `isLibrary: true`
- `data.rhythms` — Weekend Rhythm subtask source (read-only here)

### Three Buckets

See [Section C](#c-task-architecture--the-three-bucket-model) for full details.

**Weekend Rhythm:** Read-only view of `data.rhythms[*].subtasks[]`. Header shows "Edit subtasks in Rhythms" hint. No add/edit controls.

**Daily Defaults:** Add, edit, delete. `openDailyDefaultModal()`. No scheduling controls.

**Other:** Add, edit, delete. "Add to today" button → choice modal (Add to planner / Add to Today dock). Duplicate guard prevents double-adding.

### Edge Cases

- **No weekend routine configured:** "No weekend routine set up yet. Add subtasks to a weekend rhythm in Rhythms."
- **No daily defaults:** "No daily defaults yet. Tap + Add to create one."
- **No other library tasks:** "No library tasks yet. Tap + Add task to build your collection."

---

## Section 5: Travel / Trip Planner

### Purpose

End-to-end trip planning: packing checklist, supplement calculator, pre-trip prep checklists, and outfit quantities. Pre-trip prep surfaces in Today when departure is near.

**Not for:** calendar event management, rhythm tracking.

### Owned Data

- `data.trips[]` — trip records
- `data.travelTemplates` — seeded once from `DEFAULT_TEMPLATES` in `travel.js`; contains `supplements`, `packing` (5 categories), `preTripChecklists` (3-day + night-before)

### Trip Object Shape

```js
{
  id: 'trip-xxx',
  name: 'Charleston',
  destination: 'Charleston, SC',  // optional
  departureDate: 'YYYY-MM-DD',
  returnDate: 'YYYY-MM-DD',       // optional
  tripDetails: { days, nights, nightsOut, workoutDays },
  packedItems: { [itemId]: true },    // checked packing items
  checklist3Day: { [itemId]: true },  // 3-day prep checks
  checklistNight: { [itemId]: true }, // night-before prep checks
  createdAt: 'ISO'
}
```

**Trip status** is computed at render time: `upcoming` (departureDate > today), `active` (departureDate <= today AND returnDate >= today), `past` (returnDate < today). Never stored.

### Dashboard → Detail Navigation

Module-level `activeTripId` variable (not in state). Dashboard shows all trips sorted: upcoming → active → past. Clicking a trip card sets `activeTripId` and calls `render()`. Back button clears `activeTripId`.

### Quantities → Live Recalculate

Trip detail has 4 number inputs (days, nights, nights out, workout days). `input` event handler immediately commits to state AND updates the outfit summary and supplement table in-DOM without a full re-render.

**Outfit calculation:** daytime = days, PJs = ceil(nights/2), nights out = nightsOut, workout = workoutDays.

**Supplement calculation:** `count = multiplier × (basis === 'days' ? days : nights)`. AM supplements multiply by days; most PM supplements multiply by nights; Melatonin multiplier is 3 (×3 per night).

### Today Integration (`renderTripPrepForToday`)

Called by `today.js render()`. Finds the most imminent upcoming trip. If `daysUntil(departureDate)` is 1–3: shows 3-day checklist. If 0–1: also shows night-before checklist. Checks commit directly to `trip.checklist3Day` / `trip.checklistNight`.

### Week Integration

Any trip's `departureDate` that falls within the week gets a `✈ [trip name]` marker in that day column.

### Edge Cases

- **No trips:** "No trips yet. Tap **+ New Trip** to plan your first one."
- **Trip with no dates:** Status defaults to `upcoming`.
- **Packing progress:** `0/N packed` when nothing is checked.

---

## Section 6: People / Sponsees

### Purpose

Relationship tracking. Primary purpose is keeping Meagan connected to her sponsees on a regular cadence, and tracking birthdays/sobriety anniversaries for family and friends.

**Terminology requirement: Always use "sponsee" / "sponsees" for people with `category === 'sponsee'`. Never substitute "friend," "contact," or "person."**

**Not for:** general address book, meeting scheduling.

### Owned Data

- `data.people[]`

### Person Object Shape

```js
{
  id: 'per-xxx',
  name: 'Madison',
  category: 'sponsee' | 'family' | 'friend',
  cadenceDays: 7,        // null for friends
  lastContactAt: 'YYYY-MM-DD' | null,
  stepWork: { currentStep: 1-12 | null, notes: '' },  // sponsees only
  birthday: 'MM-DD' | null,   // family + friends
  sobrietyDate: 'YYYY-MM-DD' | null,  // family + friends
  contactLog: [{ id, date, type, note }]
}
```

### People Categories

- **Sponsees (3):** Alexis, Madison, Mary. Cadence: 7 days. Step work tracking. No birthday/sobriety fields.
- **Family (3):** Brother, Dad, Pam. Cadence: 180 days. Birthday stored.
- **Friends (11+):** No cadence. Birthday + sobriety date. Sorted alphabetically.

### Pulse System

`pulseStatus(person)` returns: `'ok'` (within cadence), `'warn'` (up to 1.75× cadence), `'overdue'` (beyond 1.75× cadence), `'never'` (never contacted), `'none'` (no cadence set — friends).

Colored dot shown on sponsee and family cards. Friends show no dot — they have no cadence to track.

### Logging Contact

`logContact(personId, type, note, date)` inserts to front of `contactLog` and advances `lastContactAt` only if the logged date >= current `lastContactAt` (retroactive entries don't roll back the last-contact marker).

"Add to today" creates a tray task titled `"Call [Name]"` (30m) or `"Meet [Name]"` (60m) with `category: 'people'`.

### Upcoming Events (Today Integration)

`renderUpcomingEvents()` scans all people for birthdays and sobriety dates within 14 days. Shown in `#today-people-events` on Today. Format: `🎂 [Name]'s birthday — tomorrow` / `✨ [Name]'s sobriety anniversary (N yr) — in 3 days`.

### Week Review Integration

`contactLog` entries within the week range trigger the People line in Week Review. "sponsee" / "sponsees" wording is used when `relationship === 'sponsee'`. See [Section D](#d-week-view--week-review-logic) for exact wording rules.

---

## Section 7: Brain Dump

### Purpose

A calm parking lot for ideas. No pressure to process. Capture anything: shows, movies, project ideas, things to research, reminders. Category-filter to browse. Promote to tasks when ready.

**Not for:** scheduling, tracking, or acting on items.

### Owned Data

- `data.brainDump[]`
- `data.brainDumpImportV1` — one-time import flag

### Item Object Shape

```js
{
  id: 'bd_xxx',
  text: 'Watch Poldark',
  category: 'shows',
  createdAt: 'ISO',
  status: 'active' | 'archived',
  promotedTo: null | { type: 'task', targetId: '...', label: 'Task Library' },
  notes: '',
  link: '',
  checklist: [{ id, text, done }]
}
```

### Categories

`uncategorized`, `shows`, `movies`, `books`, `podcasts`, `writing`, `claude-projects`, `places`, `other`, `dont-forget`.

### Keyboard Shortcut

Global `b` key opens Brain Dump and focuses the capture input. Only fires when: key is `b`/`B`, no modifier keys, no input/textarea/select is focused, no modal is open.

### Promotion

"Promote" button opens a modal with three destination options:
1. **Task Library** → creates `isLibrary: true, isDefaultDaily: false` record in `data.tasks`
2. **Daily Default** → creates `isLibrary: true, isDefaultDaily: true` record
3. **Weekend Rhythm subtask** → adds to `rhythm.subtasks[]` (if any weekends rhythms exist)

After promotion, `bdItem.promotedTo` is set — the item shows a "→ [destination]" badge and the Promote button is hidden.

### Edge Cases

- **Archived items:** Filtered out of all views (`status === 'archived'`). Currently no UI to archive — all deletes are hard deletes.
- **Filter "All":** Shows everything that isn't archived.
- **Empty state (all):** "Nothing here yet. Type something above to save it."
- **Empty state (filtered):** "Nothing in this category yet."

---

## Section 8: Quotes

### Purpose

A personal quote library. One quote is surfaced on the Today view per session.

### Owned Data

- `data.quotes[]` — `{ id, text, author, addedAt }`

### Session Quote

`getSessionQuote()` picks a random index on first call per session and stores it in `sessionStorage['pike-quote-idx']`. The same quote shows all day. Adding or deleting a quote clears the session index. The next Today render re-picks randomly from the new pool.

### Today Integration

Rendered by `Pike.quotes.render()` into `#today-quote-card`. If no quotes: card is hidden. Author is optional — if blank, the `— Author` line is not rendered.

### Default Quotes

8 quotes seeded on first boot (when `data.quotes` is empty or missing). All are personal/reflective quotes, mostly anonymous or James Clear/Eric Hoffer/Bill Bullard.

---

## Section 9: Settings / Sync / Auth

### Purpose

Configuration surface. Currently shows: Google Calendar connection status and connect/disconnect controls, plus a "Configurable later" card showing hardcoded defaults.

**Not for:** creating tasks, managing rhythms, editing people.

### Google Calendar

Two sources: `personal` (rose color) and `work` (sage color). Each can be connected independently. Connection flow: OAuth popup → Supabase Edge Function proxy → postMessage back to app → `syncSource()` → `render()`. Fetches forward 30 days of events on sync. Stores events in `data.calendarEvents[]`.

**Event shape in `data.calendarEvents`:**
```js
{ id, title, date, start, end, isAllDay, source: 'personal' | 'work' }
```

### Hardcoded Defaults (Settings Card)

- Default workday start: `10:00`
- Weather location: `34.0232, -84.3616` (Roswell, GA)
- Day window: `5:00 AM – 11:00 PM`

These are set in `js/state.js` `defaultState()`. A proper Settings UI is planned but not built.

---

## G. Known Regression Traps

### Regression 1: Rhythm Schedule Button Invisible on Mobile

**Symptom:** Weekend Rhythm subtasks appear in Today's rhythm section but cannot be tapped to schedule. They look like passive checklist items only.  
**Root cause:** `.today-rhythm-sched-btn` had `opacity: 0` default with `:hover` reveal only. Touch devices have no hover state.  
**Affected files:** `styles/today.css`  
**Correct behavior:** `opacity: 0.5` default (always visible), `opacity: 1` on `:hover`. Fixed in `today.css v6`.  
**Regression trigger:** Any edit to `.today-rhythm-sched-btn` CSS that sets `opacity: 0` as the base style.

### Regression 2: Cross-Device Sync Lost (`_localTs` approach)

**Symptom:** Data entered on phone doesn't appear in Chrome (or vice versa). Pike always uses the local state and never pulls from Supabase.  
**Root cause:** `_localTs = Date.now()` stamped onto `state.data` in `commit()`. Different devices have independent wall clocks. Chrome's `_localTs` (set at 9 AM) > phone's `_localTs` (set at 7 AM), so `pullOnce` guard always fires and Chrome never applies phone data.  
**Affected files:** `js/state.js`, `js/db.js`  
**Correct behavior:** `_localTs` removed from `commit()`. `pullOnce` guards against stale data using Supabase's `updated_at` compared to `localStorage['pike.sync.last_at']`. Both devices share the same Supabase clock.  
**Regression trigger:** Any re-introduction of per-device wall-clock comparison in `pullOnce()`.

### Regression 3: Auth Unlock Persisting Across Sessions

**Symptom:** Pike never reprompts for the passphrase, even after closing and reopening the app. On iOS, the app stays permanently unlocked.  
**Root cause:** `localStorage.setItem(SESSION_KEY, '1')` persists indefinitely.  
**Affected files:** `js/auth.js`  
**Correct behavior:** All auth SESSION_KEY reads/writes use `sessionStorage`, which clears when the tab/app closes.  
**Regression trigger:** Changing `sessionStorage` back to `localStorage` in `auth.js`.

### Regression 4: Half-Hour Guide Marks Invisible

**Symptom:** The dashed tick marks between hour rows on the Today timeline are not visible.  
**Root cause:** `.tl-hour-row::after` used `border-top: 1px dashed var(--line-soft); opacity: 0.5`. `--line-soft` (#EFE8DB) at 0.5 opacity against warm ivory (#F8F4ED) is essentially invisible.  
**Affected files:** `styles/today.css`  
**Correct behavior:** `border-top: 1px dashed var(--line); opacity: 0.7`. `--line` (#E6DFD2) is darker and visible at 0.7 opacity.  
**Regression trigger:** Changing the `::after` pseudo-element color back to `--line-soft` or reducing opacity below 0.5.

### Regression 5: Daily Rhythms Still Appearing in Rhythms Section

**Symptom:** After migration, a rhythm with `schedule.type === 'daily'` still appears in the Rhythms weekly routines list.  
**Root cause:** `migrateDailyRhythmsToDefaults()` not running or running before `rhythms.init()` creates the daily rhythms (ordering issue), or migration guard not firing because the rhythm already existed.  
**Affected files:** `js/recurrence.js`, `js/app.js`  
**Correct behavior:** `migrateDailyRhythmsToDefaults()` runs in `boot()` before first render AND on every state change (in the `state.on()` listener). After migration, `d.rhythms` contains no records with `schedule.type === 'daily'`.

### Regression 6: runDailyDefaults() Blocking pullOnce()

**Symptom:** After fix to sync using `updated_at`, boot-time `runDailyDefaults()` commits appear to reset state.  
**Root cause (historical, now resolved):** When `_localTs` was on state data, `runDailyDefaults()` commits would stamp a new `_localTs`, making local data appear newer than remote.  
**Current status:** Not a regression risk. `runDailyDefaults()` commits write to `pike.app_state.v1` (the state blob). `pike.sync.last_at` is only written by successful Supabase push/pull operations. Boot commits cannot affect the `pullOnce()` decision.

---

## H. Diagnostic Checklist

When a bug is reported, run through these checks before touching code.

### Step 1: Identify the Symptom Layer

- Is data missing, wrong, or not persisted? → Sync/state issue
- Is something not rendering at all? → JS render function issue or empty state trigger
- Is something visible but not interactive? → CSS issue (opacity, pointer-events, z-index) or missing event listener
- Is something visible on desktop but not mobile? → Hover-only access or HTML5 drag-only behavior
- Is data correct on one device but not the other? → Cross-device sync issue

### Step 2: State Shape Check

Open browser console and run:
```js
Pike.state.data
```
Verify:
- `rhythms` array exists and has entries
- `rhythmCompletions` object exists
- `tasks` array has the expected entries
- `trips` array exists
- `people` array has entries
- `workoutSequence.order` has 4 entries
- `travelTemplates` is not null
- The problematic data is actually there (not just a render issue)

### Step 3: Sync Check

```js
localStorage.getItem('pike.sync.last_at')   // Should be an ISO string
Pike.db.getMode()                            // 'online', 'syncing', or 'local'
```

If mode is `local`: Supabase not configured or SDK failed to load. App runs local-only.  
If `last_at` is null: Device has never successfully synced. `pullOnce` will pull on next load.  
If `last_at` is set: Compare against Supabase `updated_at` to determine if cross-device sync should trigger.

### Step 4: Rendering Check

- Check if the relevant element exists in DOM: `document.getElementById('today-rhythm-list-wrap')`
- Check if the relevant section is active: `document.querySelector('.section.is-active').id`
- For Today rhythms specifically: Are rhythms present for today's day? (`Pike.state.data.rhythms.filter(r => r.active)`)

### Step 5: CSS Check

Inspect the element in DevTools:
- Check `opacity` value (should not be 0 for interactive controls)
- Check `display: none` or `visibility: hidden`
- Check `pointer-events: none`
- Check `z-index` stacking (modals, overlays)

### Step 6: Mobile vs Desktop Check

- Does the issue reproduce on desktop Chrome? If not, it is likely a hover-only or drag-only problem.
- Does the `→` schedule button exist in DOM? (`document.querySelectorAll('.today-rhythm-sched-btn')`)
- Is `opacity` > 0? (`getComputedStyle(el).opacity`)

### Step 7: Persistence Check

1. Make a change.
2. Open DevTools → Application → localStorage → `pike.app_state.v1`.
3. Verify the change is in the JSON.
4. Reload. Verify the change survives.
5. If it survives locally but not cross-device: sync issue.
6. If it doesn't survive reload: `state.commit()` was not called (JS bug).

---

## I. Non-Negotiable Invariants

These behaviors must never be broken by future refactors, regardless of what the change is "trying to achieve."

1. **The `→` schedule button on Today's rhythm items must always be visible and tappable on mobile.** `opacity: 0` (or any other technique that hides it from touch) is forbidden. Current implementation: `opacity: 0.5` baseline.

2. **Auth unlock must use `sessionStorage`, never `localStorage`.** Pike must reprompt for the passphrase every fresh open. This is intentional, mirrors Triage, and must never be changed to persistent storage.

3. **`pullOnce()` must use Supabase `updated_at` (server timestamp) for cross-device staleness detection.** Per-device wall clocks (`Date.now()`) must never be used for this comparison. The `pike.sync.last_at` key in localStorage stores the last server `updated_at` this device applied.

4. **`state.data._localTs` must never be stamped in `commit()`.** This was the root cause of the 2026-05 cross-device sync regression. `state.lastLocalCommitAt` (in-memory only, for the 10-second realtime guard) is fine and unrelated.

5. **Weekend Rhythm subtasks must never appear in `data.tasks` as library records.** They live in `data.rhythms[*].subtasks[]`. The only time they appear in `data.tasks` is as transient planner instances created by `scheduleRhythmRefAt()` with `isRhythmRef: true`.

6. **Daily default library records must have both `isLibrary: true` AND `isDefaultDaily: true`.** A record with only `isLibrary: true` is an "Other" library task (no auto-population). A record with only `isDefaultDaily: true` would be ignored by `runDailyDefaults()`.

7. **Completing a rhythm-linked planner task (`isRhythmRef: true`) must also call `markSubtaskDone()` or `markRhythmDone()`.** This keeps the rhythm checklist in Today in sync with the planner. The bridge is in `today.js openTaskModal()` submit handler.

8. **The Week Review must never render an incomplete sentence.** If no data exists for a category, skip it entirely. Never render: "You connected with this week." or "You kept up with ." Guard every sentence against empty arrays/null data before appending to `lines`.

9. **"Sponsee" / "sponsees" must be used in the Week Review (and all UI) for people with `category === 'sponsee'`.** Never substitute "friend," "person," or "contact."

10. **`data.travelTemplates` must be initialized exactly once** (when null), using `DEFAULT_TEMPLATES` from `travel.js`. Never reinitialize if it already exists — this would wipe template customizations.

11. **The service worker cache version must be bumped whenever CSS or JS files change.** Current version: `pike-v19`. CSS query-string versions (`?v=N`) in `index.html` bust the service worker's network-first cache fetch. Both must be updated together.

12. **`state.commit()` must be the only path for mutating `state.data`.** Direct assignment to `state.data.someProperty` will not trigger `saveToLocal()`, will not emit the change event, and will not schedule a Supabase push.

---

*End of VIRTUAL_PIKE_SOURCE_OF_TRUTH.md*
