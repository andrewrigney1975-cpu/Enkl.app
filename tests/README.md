# Enkl — Test Suite

83 test files covering virtually every feature in `../dist/index.html`.  
All tests are self-contained and run with plain Node.js and jsdom — no build tools, no bundlers.

---

## Quick start

```bash
# 1. Place your app file in this folder
cp /path/to/../dist/index.html ./../dist/index.html

# 2. Install the one dependency
npm install

# 3. Run the full suite (takes 3–6 minutes)
node run_all_tests.js

# Or: use the npm shorthand
npm test

# 4. Or run a single file
node smoke_test.js
```

---

## Requirements

| Tool | Version |
|---|---|
| Node.js | 18 or newer (tested on v22) |
| npm | Included with Node |

Install Node from https://nodejs.org/ — the LTS release is recommended.

---

## Setup

```
enkl_tests/
├── README.md              ← you are reading this
├── package.json           ← declares jsdom dependency
├── run_all_tests.js       ← runs every test and prints a summary
├── ../dist/index.html      ← copy your app file here (not included)
└── *_test.js              ← 83 individual test files
```

**Copy your app file into this folder before running any tests:**

```bash
# macOS / Linux
cp /path/to/../dist/index.html ./../dist/index.html

# Windows (Command Prompt)
copy C:\path\to\../dist/index.html ../dist/index.html

# Windows (PowerShell)
Copy-Item C:\path\to\../dist/index.html .\../dist/index.html
```

All 83 test files read `../dist/index.html` from the same directory they live in.

---

## Running individual tests

Each file is a standalone async script. Run any one directly:

```bash
node smoke_test.js
node health_dashboard_test.js
node teams_committees_test.js
```

Every assertion prints `PASS - ...` or `FAIL - ...` on its own line, making it easy to grep:

```bash
node smoke_test.js | grep FAIL
```

---

## Running all tests

`run_all_tests.js` runs every `*_test.js` file in sequence and prints a final tally:

```bash
node run_all_tests.js
```

Example output:

```
Running 83 test files...

  pass  smoke_test.js                                     12/12
  pass  team_test.js                                      18/18
  FAIL  depmap_zoompan_test.js                            6/8
         FAIL - wheel up (negative deltaY) zooms in
         FAIL - panning class applied while mouse is held
  ...

─────────────────────────────────────────────────────────────────
TOTAL: 1948 pass, 2 fail  (83 files)
```

---

## Known batch flakiness

A small number of tests (roughly 5 out of 83) occasionally fail when run as part of the full batch sweep, but pass reliably when run alone. This is a jsdom resource-contention issue — when many JSDOM instances initialise simultaneously inside the same Node process, occasional timing races can corrupt state.

**Rule: if a test fails in the full sweep, run it alone three times before treating it as a real failure:**

```bash
for i in 1 2 3; do node <failing_test>.js | grep -c "^FAIL"; done
# if all three print "0", it was a batch flake, not a regression
```

Tests that show this behaviour (but are clean in isolation):

- `depmap_zoompan_test.js`
- `assignee_dropdown_test.js`
- `backup_reminder_test.js`
- `default_score_alert_test.js`
- `tasklist_column_field_test.js`

---

## Test file index

### Core data & persistence

| File | What it covers |
|---|---|
| `smoke_test.js` | App loads, project CRUD, basic task operations |
| `migration_test.js` | `migrateDB()` backfills missing fields on legacy data |
| `import_test.js` | Full JSON import round-trip |
| `import_conflict_test.js` | Import conflict modal (copy vs overwrite) |
| `member_export_import_test.js` | Team members with ID re-mapping |
| `documents_risks_decisions_export_import_test.js` | All entity types through export/import |
| `overwrite_key_bug_test.js` | Key re-mapping on project overwrite |
| `backup_reminder_test.js` | Stale-export backup reminder |
| `columns_export_test.js` | Kanban column export |

### Tasks & Board

| File | What it covers |
|---|---|
| `team_test.js` | Team member add/remove/rename |
| `task_dates_test.js` | Task start/end dates |
| `dates_test.js` | Project date fields |
| `done_sort_test.js` | Completed tasks sort to the bottom of Done |
| `archived_test.js` | Archiving tasks |
| `overdue_test.js` | Overdue task detection and alerts |
| `cost_value_test.js` | Business value and task cost fields |
| `default_score_alert_test.js` | Alert when tasks have the default score of 1 |
| `bulk_edit_test.js` | Bulk task editing |
| `bulk_edit_release_test.js` | Bulk-assigning tasks to a release |
| `bulk_edit_task_type_test.js` | Bulk-changing task types |
| `bulk_edit_grid_tracks_test.js` | Bulk edit modal grid layout |
| `private_task_test.js` | Private tasks: encrypted description, unlock/continue-without-key flows, board/dep-map lock badges, export/import round-trip |

### Task Types & Releases

| File | What it covers |
|---|---|
| `task_types_test.js` | Task type CRUD and icon picker |
| `task_type_icons_test.js` | Icon rendering on task cards |
| `task_type_icon_picker_floating_test.js` | Icon picker panel positioning |
| `task_type_filter_test.js` | Filtering by task type |
| `releases_test.js` | Release CRUD |
| `tasklist_release_grouping_test.js` | List view grouped by release |
| `bulk_edit_release_test.js` | Bulk release assignment |

### Views & Tools

| File | What it covers |
|---|---|
| `tasklist_test.js` | List view |
| `tasklist_column_field_test.js` | Column field in list view |
| `tasklist_grid_tracks_test.js` | List view grid layout |
| `tasklist_collapsible_groups_test.js` | Collapsible groups in list view |
| `timeline_test.js` | Timeline (Gantt) view |
| `timeline_bar_avatar_test.js` | Assignee avatars on timeline bars |
| `timeline_bar_type_icon_test.js` | Task type icons on timeline bars |
| `depmap_test.js` | Dependency Map overlay |
| `depmap_test_resolved.js` | Dependency Map with resolved nodes |
| `depmap_zoompan_test.js` | Dependency Map zoom/pan |
| `depmap_archive_toggle_test.js` | Show/hide archived in Dependency Map |
| `depmap_marker_opacity_test.js` | Archived node opacity |
| `depmap_start_marker_test.js` | Start node marker |
| `costbenefit_test.js` | Cost/Benefit Chart |
| `costbenefit_zoompan_test.js` | Cost/Benefit zoom/pan |
| `costbenefit_archive_size_test.js` | Archived task marker sizing |
| `costbenefit_scale_diagonal_test.js` | Scale diagonal rendering |

### Entity Modules

| File | What it covers |
|---|---|
| `documents_test.js` | Documents module CRUD |
| `document_related_docs_test.js` | Related documents linking |
| `documentation_field_test.js` | Documentation URL field on tasks |
| `documents_link_search_test.js` | Search within Documents |
| `risks_test.js` | Risks module CRUD |
| `risks_decisions_search_test.js` | Search within Risks and Decisions |
| `decisions_test.js` | Decisions module CRUD |
| `decisions_new_fields_test.js` | Principles/objectives fields on Decisions |
| `principles_objectives_test.js` | Principles and Objectives modules |
| `teams_committees_test.js` | Teams & Committees CRUD, hierarchy, membership |
| `teams_committees_search_test.js` | Teams & Committees in Project Search |
| `reports_to_test.js` | Team member "Reports To" field |
| `team_member_role_test.js` | Team member Role field |
| `team_modal_iconpicker_width_test.js` | Team modal layout |
| `team_filter_test.js` | Team filter on the board |

### Health Dashboard

| File | What it covers |
|---|---|
| `health_dashboard_test.js` | All five gauge scores and sub-formulas |
| `health_button_rename_test.js` | Button label, position, App Settings order |
| `health_gauge_animation_test.js` | Gauge animation timing and settle behaviour |
| `health_risk_matrix_test.js` | 5×5 risk matrix chart and export |

### Project Search

| File | What it covers |
|---|---|
| `project_search_test.js` | All entity types, field coverage, gating, click-through |
| `teams_committees_search_test.js` | TC-specific search result layout |

### UI & Navigation

| File | What it covers |
|---|---|
| `app_settings_test.js` | App Settings toggles and live gating |
| `header_more_menu_test.js` | "More..." dropdown and mobile collapsible |
| `projects_dropdown_test.js` | "Projects..." desktop dropdown |
| `mobile_drawer_test.js` | Mobile drawer open/close |
| `mobile_menu_layout_test.js` | Mobile menu layout |
| `view_buttons_relocation_test.js` | View buttons on mobile |
| `side_nav_test.js` | Desktop side navigation |
| `drawer_spacing_test.js` | Drawer spacing/layout |
| `assignee_dropdown_test.js` | Assignee dropdown in task form |

### CSS & Visual Regressions

| File | What it covers |
|---|---|
| `css_source_order_test.js` | Base rules appear before `@media` blocks (critical) |
| `hidden_class_css_backing_test.js` | Every `.hidden` toggle has a `display:none` rule |
| `font_weight_test.js` | `font-weight:600` only on the board title |
| `header_logo_design_test.js` | Logo SVG square/full-bleed design |
| `app_icon_square_design_test.js` | PWA icons are square and full-bleed |
| `theme_test.js` | Light/dark theme toggle |
| `rebrand_test.js` | App name "Enkl" present throughout |

### Misc

| File | What it covers |
|---|---|
| `app_version_test.js` | Version string format |
| `project_dates_test.js` | Project start/end dates |
| `pwa_support_test.js` | PWA manifest and apple-touch-icon |
| `export_as_test.js` | SVG/PNG export from charts |

---

## Writing a new test

All 83 tests follow the same boilerplate pattern:

```javascript
const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('./../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: 'usable',
    url: 'http://localhost/',
    pretendToBeVisual: true
  });
  await wait(300); // let DOMContentLoaded and startup code run

  const doc = dom.window.document;
  function log(label, ok, extra){
    console.log((ok ? 'PASS' : 'FAIL') + ' - ' + label
      + (extra !== undefined ? ' :: ' + extra : ''));
  }

  // --- interact and assert ---
  doc.getElementById('someBtn').click();
  await wait(20);
  log('button opened the modal', !doc.getElementById('someModal').classList.contains('hidden'));

  console.log('\nMy test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
```

### Timing guide

| Wait | When to use |
|---|---|
| `await wait(300)` | After `new JSDOM(...)` — required for app startup |
| `await wait(20)` | After a click or form interaction |
| `await wait(250)` | After typing into a search field (200ms debounce) |
| `await wait(1700)` | After opening the Health Dashboard (gauge animation: 0.5s delay + up to 0.9s sweep) |
| `await wait(350)` | After loading a second JSDOM in the same test (legacy migration tests) |

### File imports that need mocking

Some tests need to mock browser APIs that jsdom doesn't implement. Copy the relevant block from an existing test that already uses that API:

| API | Example test |
|---|---|
| `FileReader` (JSON import) | `import_test.js` |
| `URL.createObjectURL` + `Blob` (export) | `export_as_test.js` |
| `HTMLCanvasElement.toBlob` (PNG export) | `health_risk_matrix_test.js` |
| `Image` (SVG export) | `export_as_test.js` |
| `crypto.subtle` (private tasks — jsdom has no Web Crypto implementation) | `private_task_test.js` |
