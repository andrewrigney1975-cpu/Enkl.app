# The Enklr Task User Guide

*A practical, living guide to running your work through Enklr Task — from a five-minute solo
sandbox to a whole organisation's portfolio of projects.*

---

## Before we start: three people you'll meet again

To keep the examples grounded, this guide follows the same small cast throughout:

- **Priya** runs a five-person product team and lives in the board every day.
- **Marcus** is a developer on Priya's team — he mostly just wants to know what's assigned to him.
- **Elena** is the Org Admin — she doesn't touch individual tasks much, but she's accountable for
  who has access to what, and for reporting upward on how the whole portfolio is doing.

You'll see them pop up wherever a feature makes more sense with a face attached to it.

This guide is organised the same way the app's own menus are, so if you're staring at a button and
wondering what it does, you can jump straight to the matching section rather than reading front to
back. It will keep growing as new features ship — treat each section as a self-contained chapter,
because eventually that's exactly what they'll become on a proper help site.

---

## Table of contents

1. [Getting started — where does Enklr Task actually live?](#1-getting-started--where-does-enklr-task-actually-live)
2. [The Board — your home base](#2-the-board--your-home-base)
3. [Anatomy of a Task](#3-anatomy-of-a-task)
4. [Seeing your work differently — the Views](#4-seeing-your-work-differently--the-views)
5. [Tools — everyday utilities](#5-tools--everyday-utilities)
6. [Governance & knowledge — the "why," not just the "what"](#6-governance--knowledge--the-why-not-just-the-what)
7. [Search and the Advanced Query workbench](#7-search-and-the-advanced-query-workbench)
8. [Collaboration — Chat and comments](#8-collaboration--chat-and-comments)
9. [Portfolio & organisation management](#9-portfolio--organisation-management)
10. [Making it yours — personalisation](#10-making-it-yours--personalisation)
11. [Data, backup, and moving between tiers](#11-data-backup-and-moving-between-tiers)
12. [Reports and exporting](#12-reports-and-exporting)
13. [Roles and permissions, in plain terms](#13-roles-and-permissions-in-plain-terms)
14. [Quick reference index](#14-quick-reference-index)

---

## 1. Getting started — where does Enklr Task actually live?

Before any feature makes sense, it helps to know that Enklr Task isn't one fixed thing — it's the
same app running at three different levels of commitment. You don't have to pick the "right" one on
day one; you can start at the shallow end and walk in deeper later without losing any work.

### Option A — On your own device, nothing installed

**What it is**: open `index.html` in a browser — even by double-clicking the file with no internet
connection — and the whole app runs. Every task, column, and setting is saved straight into your
browser's local storage. Nothing leaves your machine.

**Who it's for**: Sam, a freelancer who wants to plan a single project this afternoon and doesn't
want to create an account for it. Also the right choice for anyone kicking the tyres before
recommending Enklr Task to a team.

**How**: just open the app. A short "what's your name?" prompt appears the very first time (so your
seed project has a real first member instead of a placeholder), and after that you're straight into
a working board with example data already on it. There's no login screen at this level — "logged
out" *is* the normal state.

### Option B — Self-hosted for your organisation

**What it is**: the same frontend, now talking to a real backend your organisation runs — most
commonly through Docker, on your own servers or cloud account. Once connected, projects become
"server-authoritative": real accounts, real roles, live updates when a colleague changes something,
and org-wide features like Chat and the Portfolio Dashboard switch on.

**Who it's for**: Elena's organisation, once they've outgrown solo sandboxes and need shared,
auditable, multi-person project data — with full control over where that data physically lives.

**How**: from an existing local project, open the account menu and choose **Migrate to Server**
(only shown once a server is actually reachable). This converts your local project into a
server-hosted one in place — nothing is thrown away. The very first person to migrate a project into
a brand-new organisation automatically becomes that organisation's Org Admin.

### Option C — A hosted instance, ready to use

**What it is**: the same self-hosted backend from Option B, except someone else runs the
infrastructure and your organisation simply signs in — no server to provision, no Docker to learn.
Each organisation's data stays walled off from every other organisation on the same instance, the
same isolation guarantee as Option B, just without the operational overhead.

**Who it's for**: teams that want everything Option B offers — real accounts, live updates,
portfolio reporting — without taking on hosting themselves.

**How**: your administrator gives you a URL and, if you're the first person in, you'll go through the
same "Migrate to Server" or sign-up flow described above. Everything from Section 2 onward behaves
identically regardless of which of these three options you're on — the only thing that changes is
*where the data lives* and *who else can see it*.

---

## 2. The Board — your home base

**What it is**: a Kanban board — columns represent stages of work (say, *To Do → In Progress →
Review → Done*), and cards represent individual tasks that move across them as work progresses.

**Who it's for**: everyone. This is the screen you'll spend the most time on, whether you're Priya
planning next week or Marcus checking what's landed on him today.

**How it works, piece by piece:**

- **Adding a column** — click **+ Column** on the toolbar. Give it a name, an optional colour, and
  decide whether it represents *done* work. Marking a column "Done" matters more than it looks: it's
  what the app checks before letting a dependent task move, so a blocked task can't sneak past a
  step it's actually waiting on.
- **Adding a task** — click into any column's add-task control. A minimal task needs only a title;
  everything else in [Section 3](#3-anatomy-of-a-task) is there when you need it, not before.
- **Moving work** — drag a card between columns, or reorder cards within one column, the way you'd
  expect from any Kanban tool. If a task depends on another one that isn't finished yet, the app
  shows you that visually as you drag, rather than letting the move silently fail.
- **Filtering** — the toolbar's priority chips and the Team/Assignee/Task Type dropdowns combine
  together, so Marcus can, in one click, see only *his* tasks, then narrow that further to just the
  critical ones.
- **Searching** — the search box matches task titles and descriptions, and also understands
  `#hashtags` written into a task's description (more on that in [Section 8](#8-collaboration--chat-and-comments)) — type `#launch` and every task
  mentioning it surfaces immediately.
- **Wide-screen mode** — on a genuinely large monitor (2560 pixels or wider), opening a task docks
  its modal alongside the board instead of covering it, so you can glance between the two without
  closing anything.
- **On a phone or narrow tablet** — the header collapses behind a hamburger menu, and the toolbar's
  extra buttons move into a slide-out drawer, so the board itself stays uncluttered on small screens.

---

## 3. Anatomy of a Task

A task is where almost every other feature in this guide eventually connects back to. It's worth
knowing the full shape of one even if you only ever fill in a fraction of it on any given task.

**What it is**: the single record of one piece of work — everything from its title to who's doing it,
what it depends on, and the conversation that happened around it.

**Who fills in what**: Priya tends to set priority, dates, and dependencies when she plans work;
Marcus updates progress and adds comments as he does it. Nobody is expected to touch every field —
most of them exist for the minority of tasks that actually need them.

**The fields, grouped by what they're for:**

- **Identity** — Title, Task Type (a customisable label like *Bug* or *Feature*, each with its own
  icon), Priority (*Trivial → Low → Medium → High → Critical*).
- **The description** — a full rich-text editor (bold, italic, headings, lists, links) rather than a
  plain textbox, because task write-ups are often more than one paragraph. Typing `#` inside it
  offers hashtag autocomplete, and a documentation URL field sits alongside it for linking out to an
  external spec or wiki page.
- **Scheduling** — Column, Release, Start/End dates, Progress percentage, and optional
  estimated-vs-actual effort hours if your team tracks time.
- **Value and cost** — a 1–1000 Business Value score and a matching Task Cost score. Neither is
  mandatory, but together they're what powers the Cost/Benefit chart in
  [Section 4](#4-seeing-your-work-differently--the-views) — plot every task by value against cost and
  the ones worth doing first tend to jump out visually.
- **Structure** — a task can have a Parent Task and its own Sub-Tasks, and it can Depend On other
  tasks. Dependencies are cycle-checked as you add them, so you can't accidentally create a loop
  where two tasks are each waiting on the other.
- **Privacy** — checking **Private** encrypts the task's content in your browser using a passphrase
  only you know, before it's ever saved. A locked private task shows nothing but its title until
  unlocked with that same passphrase. There's a real trade-off here worth saying plainly: **nobody,
  including your organisation's administrators, can recover a private task's content if you forget
  the passphrase** — treat it the way you'd treat a password to an encrypted file, not a normal app
  password with a reset link.
- **The conversation** — a Comments section (add, edit your own, delete your own, sorted oldest- or
  newest-first) and, below it, a collapsible Audit Trail recording what changed on the task and when.
- **Archiving** — an Archived checkbox tucks a task out of the active board without deleting it; see
  [Section 5](#5-tools--everyday-utilities) for how to find it again later.

---

## 4. Seeing your work differently — the Views

The board is the default lens, but it's rarely the only useful one. Every view below is reading the
*same* underlying tasks — switching views never duplicates or moves data, it just changes how it's
drawn.

- **List View** — **What**: every task as a flat, sortable, filterable table. **Who**: anyone who
  wants to scan or bulk-scan the whole task list rather than scroll a board. **How**: pick it from
  the side nav or the toolbar's view row.
- **Timeline** — **What**: a Gantt-style chart, one row per task, laid out against real calendar
  time. **Who**: Priya, when she needs to see whether two workstreams overlap awkwardly next month.
- **Dependency Map** — **What**: a left-to-right diagram of which tasks block which. **Who**:
  invaluable the moment a project has more than a handful of interdependent tasks and "what's
  actually blocking us" stops being obvious from the board alone.
- **Cost/Benefit Chart** — **What**: a quadrant plot of every scored task, Task Cost on one axis,
  Business Value on the other. **Who**: Priya again, prioritising a backlog — the "high value, low
  cost" quadrant is usually where the next sprint's work should come from.
- **Org Chart** — **What**: a top-down chart of your Teams & Committees structure. **Who**: useful
  context for anyone new to a project who needs to understand who's who before they start pinging
  people.
- **Governance Map** — **What**: a radial diagram with the project at the centre and its Risks,
  Decisions, Principles, Objectives, and Documents arranged around it as connected hubs. **Who**: a
  genuinely nice one-screen answer to "what's the governance state of this project," useful in a
  stakeholder review.

---

## 5. Tools — everyday utilities

- **Bulk Edit** — **What**: select many tasks at once and change a shared field (priority, column, a
  date) across all of them in a single action. **Who**: Priya, re-planning a whole release in one
  pass instead of opening ten tasks individually. **How**: open it from the toolbar, tick the tasks,
  choose the field and new value.
- **To-Do** — **What**: a personal list, separate from the shared board — a private scratch-pad for
  things that aren't formal tasks yet. **Who**: anyone who thinks in personal checklists before
  committing something to the team's board.
- **Archived** — **What**: the holding area for tasks you've checked "Archived" on. **Who**: anyone
  tidying a board without deleting history — an archived task can always be found and reactivated
  here.
- **Task Types** — **What**: define the custom labels (*Bug*, *Feature*, *Chore*, whatever fits your
  team) that appear on the task's Type field and its icon on the card. **Who**: usually set up once,
  early, by whoever's establishing conventions for a project.
- **Releases** — **What**: a register of releases (with status and target dates) that tasks can be
  tied to. **Who**: teams that ship in named batches rather than continuously.
- **Workflow** — **What**: a visual editor where each board column becomes a node, and you draw the
  allowed transitions between them as edges. **Who**: Elena or Priya, the first time they want to
  *enforce* that a task can't jump straight from "To Do" to "Done" without passing through "Review."
  Once defined, the workflow engine actively blocks moves that don't follow an allowed edge.

---

## 6. Governance & knowledge — the "why," not just the "what"

Five registers live alongside the board, each capturing a different kind of project knowledge that
doesn't fit neatly into a task card. They all share a family resemblance — a list, a form, a status
or scoring field — so once you've used one, the rest feel familiar.

- **Principles** — the guiding rules a project has agreed to work by. **Who**: set early, referenced
  often, changed rarely.
- **Objectives** — what the project is actually trying to achieve. **Who**: useful to point to when
  someone asks "wait, why are we doing this task at all?"
- **Documents** — a register of project documents, with the app suggesting related documents to each
  other as you write them (a background keyword matcher, not something you configure).
- **Risks** — a proper risk register, each entry scored by likelihood and impact. **Who**: Priya,
  keeping an honest running list of what could go wrong rather than discovering it the hard way.
- **Decisions** — a durable record of decisions made, with a type and status. **Who**: the thing you
  wish existed six months ago when someone asks "wait, didn't we already decide against that?"

Two more sit alongside these:

- **Teams & Committees** — **What**: define the org units that feed the Org Chart view. **Who**: Elena,
  modelling how the organisation is actually structured, not just who's on which project.
- **Retrospectives** — **What**: a structured post-release reflection session, complete with a
  built-in countdown timer to keep a retro from sprawling past its box. **Who**: Priya's team, at the
  close of a release, turning "what did we learn" into something written down rather than forgotten
  by the next standup.
- **Health Dashboard** — **What**: one screen combining burndown, an overall health percentage, and
  who's carrying the most load on the team. **Who**: Priya's fastest way to answer "how are we
  actually doing" without reconstructing it from the board by eye.

---

## 7. Search and the Advanced Query workbench

- **Project Search** — **What**: a search box that reaches across the whole project — tasks,
  documents, and more — not just the board's own filter. **Who**: anyone who knows *something* about
  what they're looking for but not which register it's filed under.
- **Advanced Query** — **What**: a genuine SQL query tab over your project's own data, with
  autocomplete, a one-click "Format SQL" tidy-up, and a hand-drawn diagram of the available tables so
  you're never guessing at column names. **Who**: this is deliberately for the curious, technically
  comfortable minority — most people will never open it, and that's fine. But if you've ever wanted
  to ask a question of your project data that no built-in view quite answers ("show me every task
  over budget, grouped by assignee"), this is where you go. Saved queries can also be turned into
  reusable API endpoints for pulling data into something outside Enklr Task entirely.

---

## 8. Collaboration — Chat and comments

**What it is**: an org-wide chat — channels for group conversations, direct messages for one-on-one,
`@mentions` that ping the right person, emoji reactions, and its own light send/receive sound so you
notice a new message without staring at the tab. There's also a genuine full-screen mode for anyone
who wants chat to feel less like a bolted-on sidebar and more like its own workspace.

**Who it's for**: this only exists once you're on Option B or C from Section 1 — a fully local,
never-migrated project has no concept of "colleagues" to chat with, so Chat simply isn't present at
that level. For everyone else, it's the difference between "leaving a comment and hoping someone
checks the task" and an actual real-time conversation.

**How it fits with Task Comments**: comments (Section 3) are the permanent, task-scoped record — the
paper trail attached to one specific piece of work. Chat is the live, cross-project conversation
layer. Use comments for anything future-you (or a teammate six months from now) needs to find
attached to the task itself; use chat for the back-and-forth that doesn't need to live forever on any
one task.

**A small but genuinely useful detail**: description text and comments both understand
`#hashtags` — write `#launch` into a few related tasks and that hashtag becomes a live, clickable
thread tying them together, all without anyone having created a formal "tag" entity anywhere.

---

## 9. Portfolio & organisation management

Everything in this section only appears once your organisation is on Option B or C, and most of it
only appears for an **Org Admin** — this is Elena's territory, not Marcus's.

- **Portfolio Dashboard** — **What**: a rolled-up health view across *every* project in the
  organisation, not just one. **Who**: Elena, reporting upward on the whole portfolio rather than
  project by project.
- **Portfolio Planner** — **What**: a Gantt-style view for planning multiple projects against each
  other before committing to timelines. **Who**: Elena, sanity-checking that two projects aren't
  quietly both claiming the same quarter's capacity.
- **Manage Users** — **What**: create and manage the organisation's user accounts — including
  deactivating one when someone leaves. **Who**: Elena, onboarding Marcus's replacement without
  needing anyone to self-register, and, later, offboarding Marcus himself the day he moves on.
  **How**: click **Deactivate** next to a user's name (a confirmation dialog asks first — this can't
  be undone from this screen). They're signed out immediately and can't log back in. Elena can't
  deactivate her own account this way, a deliberate guard against locking herself out by mistake.
  Nothing about the user's past work disappears: anywhere their name would normally show up — a
  task they're assigned to, a Risk or Decision or Document they own, a message in Chat — it now
  reads their name followed by **"(Inactive)"**, so nobody mistakes old history for something still
  actionable by them. Reassigning their tasks and governance items to someone else is then a manual
  clean-up step Elena works through at her own pace, not something the deactivation does for her.
- **SSO & Provisioning** — **What**: configure SAML single sign-on and SCIM-based automatic user
  provisioning. **Who**: larger organisations that already manage identity centrally and want Enklr
  Task to plug into that rather than keep a separate set of credentials.
- **Manage Templates** — **What**: save a fully set-up project (its columns, task types, workflow) as
  a reusable template, so a new project starts from a sensible default instead of a blank board.
  **Who**: Elena or Priya, the second or third time they catch themselves rebuilding the same column
  layout from scratch.

---

## 10. Making it yours — personalisation

- **My Preferences** — **What**: personal display settings — a board background (colour, gradient, or
  your own uploaded image), a header colour, and which "opening experience" greets you. **Who**:
  entirely optional, and entirely yours — these choices are stored locally to your own browser, not
  shared with teammates.
- **Theme toggle** — light or dark, one click, in the header at all times.
- **Opening Experience** — **What**: choose what you land on when the app opens (for instance, List
  View instead of the board by default on a phone). Revisitable any time from My Preferences.

---

## 11. Data, backup, and moving between tiers

- **Export Project** — **What**: download the entire project — every task, column, comment, and
  setting — as a single backup file. **Who**: good practice for anyone on Option A (local-only), since
  there's no server copy of that data anywhere else. Sam, the freelancer from Section 1, should be
  exporting regularly.
- **Import Project** — **What**: the reverse — load a previously exported file back in, including
  into a fresh install.
- **Migrate to Server** — covered in [Section 1](#1-getting-started--where-does-enklr-task-actually-live)
  — the one-way (but non-destructive) move from a local sandbox to a real server-backed project.
- **Storage usage indicator** — **What**: a quiet warning if a local-only project's data is
  approaching your browser's storage limits — worth heeding on Option A long before it becomes
  urgent, since it's a signal to export a backup and/or migrate to a server rather than risk running
  out of room.
- **A quiet safety net**: the app will periodically nudge you about things worth knowing before they
  become problems — overdue tasks piling up, tasks that have overrun their estimate, or simply that
  it's been a while since your last backup. These aren't alarms, just gentle reminders that surface
  on their own.

---

## 12. Reports and exporting

- **Entity Reports** — **What**: a clean, printable report for any one register — Risks, Decisions,
  Principles, or Objectives — pulled straight from what's already in the app. **Who**: anyone who
  needs to hand a stakeholder a document rather than a login.
- **Project Management Report** — **What**: a single composite report combining the project's header
  info, team, and all four governance registers into one document. **Who**: Priya, preparing a
  steering-committee packet without manually assembling four separate exports.
- **Chart exports** — **What**: every hand-drawn chart in the app — Timeline, Dependency Map,
  Cost/Benefit, Org Chart, Governance Map, and more — can be downloaded as an SVG or a PNG image.
  **Who**: anyone dropping a chart into a slide deck or a written report.

---

## 13. Roles and permissions, in plain terms

Three levels, from least to most access — and worth knowing that the *server* always enforces these
independently, so nothing in the interface is a "soft" permission you could talk your way around:

- **Member** — the default for anyone added to a project. Full day-to-day board and task access
  within the projects you're actually on. This is Marcus.
- **Project Admin** — a member with extra administrative rights *scoped to one project* — managing
  that project's team, workflow, and columns. A project can have more than one Project Admin.
- **Org Admin** — administrative rights across the *whole organisation*: every screen in
  [Section 9](#9-portfolio--organisation-management), plus automatic Project Admin rights on every
  project in the org. This is Elena. The very first person to migrate a project into a brand-new
  organisation becomes its Org Admin automatically — worth remembering when you're setting one up for
  the first time.

One more distinction worth knowing: a lot of this only applies once you're server-connected (Option B
or C). A fully local project (Option A) has no accounts, no roles, and no "who's an admin" question
to answer at all — it's just you.

---

## 14. Quick reference index

| I want to… | Go to |
|---|---|
| Start using Enklr Task with zero setup | [Section 1, Option A](#1-getting-started--where-does-enklr-task-actually-live) |
| Move a solo project onto a real server | [Section 1, Option B](#1-getting-started--where-does-enklr-task-actually-live) |
| See only my own tasks | [Section 2 — filtering](#2-the-board--your-home-base) |
| Keep a task's contents secret, even from admins | [Section 3 — Privacy](#3-anatomy-of-a-task) |
| Figure out what to work on next | [Section 4 — Cost/Benefit Chart](#4-seeing-your-work-differently--the-views) |
| Understand what's blocking a task | [Section 4 — Dependency Map](#4-seeing-your-work-differently--the-views) |
| Change ten tasks at once | [Section 5 — Bulk Edit](#5-tools--everyday-utilities) |
| Stop a task moving to Done too early | [Section 5 — Workflow](#5-tools--everyday-utilities) |
| Keep a running log of project risk | [Section 6 — Risks](#6-governance--knowledge--the-why-not-just-the-what) |
| Run a proper end-of-release retro | [Section 6 — Retrospectives](#6-governance--knowledge--the-why-not-just-the-what) |
| Ask a genuinely custom question of my project data | [Section 7 — Advanced Query](#7-search-and-the-advanced-query-workbench) |
| Talk to a teammate in real time | [Section 8 — Chat](#8-collaboration--chat-and-comments) |
| See how the whole organisation's projects are doing | [Section 9 — Portfolio Dashboard](#9-portfolio--organisation-management) |
| Add a new person to the organisation | [Section 9 — Manage Users](#9-portfolio--organisation-management) |
| Offboard someone who's leaving | [Section 9 — Manage Users](#9-portfolio--organisation-management) |
| Stop rebuilding the same board layout every time | [Section 9 — Manage Templates](#9-portfolio--organisation-management) |
| Change how the board looks for just me | [Section 10 — My Preferences](#10-making-it-yours--personalisation) |
| Make sure I don't lose my local-only work | [Section 11 — Export Project](#11-data-backup-and-moving-between-tiers) |
| Hand a stakeholder a document, not a login | [Section 12 — Reports](#12-reports-and-exporting) |
| Understand what an Org Admin can do that I can't | [Section 13](#13-roles-and-permissions-in-plain-terms) |

---

*This guide covers Enklr Task's user-facing feature set as of this writing and will keep growing
alongside the app. When it's eventually split into a proper help site, each numbered section above
is designed to stand alone as its own page — so if a section feels a little more self-contained and
repeats a little more context than strictly necessary for a front-to-back read, that's deliberate.*
