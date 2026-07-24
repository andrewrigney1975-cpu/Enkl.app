"use strict";

/**
 * Ordered scenarios sharing one `ctx` across the run (tokens/ids seeded by earlier scenarios feed
 * later ones — a fresh org/project only exists once the migration-bootstrap scenario has run).
 *
 * Each `run(ctx)` fires the SAME logical request at every tier in `ctx.tiers` (whichever of
 * net/php/mariadb actually have a *_BASE_URL set — see run-parity.js) via `ctx[tier].client`, and
 * returns `{ results, exactFields? }` where `results` is an object keyed by tier name
 * (`{net: {status,body}, php: {status,body}, ...}`). The runner does the actual status/shape diffing,
 * comparing every non-reference tier against "net" — scenarios just describe what to call and,
 * optionally, which response fields should be byte-for-byte identical across tiers (only true for
 * values the harness itself set identically on every tier, like a task title).
 *
 * To add a scenario: push a new { name, run } onto this array. It runs after everything already
 * here, with ctx already carrying whatever earlier scenarios stashed on it. Use `requestAllTiers`
 * for the common "fire the identical request at every active tier" case; hand-loop over `ctx.tiers`
 * for anything that needs per-tier-varying request bodies (see migration-bootstrap/login below).
 *
 * Deliberately NOT covered yet (documented, not attempted, this pass): the SSE stream endpoint
 * (long-lived connection, a different testing shape entirely) and SAML/SCIM (need an external
 * IdP/SCIM client to exercise meaningfully).
 */

/** Fires the same request (built from `requestFn(tierState, tier)`) at every active tier in parallel. */
async function requestAllTiers(ctx, requestFn) {
  const results = {};
  await Promise.all(ctx.tiers.map(async (tier) => {
    results[tier] = await requestFn(ctx[tier], tier);
  }));
  return results;
}

function migrationFixture(runSuffix, keySuffix) {
  const key = `CP${keySuffix}`;
  return {
    organisationName: `ContractParity-${runSuffix}`,
    // Project.Key has a GLOBAL unique index (IX_Projects_Key-equivalent on every tier's schema — not
    // scoped per organisation), so this has to vary per run just like the org/member names below, or
    // a repeat run against a persistent DB 409s on the second attempt.
    project: { name: 'Contract Parity Project', key },
    // Member name must be unique per run, not just the org name: username lookup at login is global,
    // not org-scoped (AuthController matches on NormalizedUsername alone) — a repeat run reusing
    // "Parity Tester" collides with a previous run's user and gets silently renamed
    // ("Parity Tester (2)") by MigrationService's dedup logic, which would break a hardcoded login
    // credential below. Suffixing it the same way as the org name avoids that entirely.
    members: [{ id: 'm1', name: `Parity Tester ${runSuffix}`, color: '#4f46e5' }],
    columns: [
      { id: 'c1', name: 'To Do', done: false, order: 0 },
      { id: 'c2', name: 'Done', done: true, order: 1 },
    ],
    releases: null,
    taskTypes: null,
    principles: null,
    documents: null,
    risks: null,
    objectives: null,
    teamsCommittees: null,
    decisions: null,
    hierarchy: [
      { id: 't1', key: `${key}-1`, title: 'Seed task', priority: 'medium', column: 'c1', progress: 0, archived: false },
    ],
    headerButtonVisibility: null,
    workflow: null,
  };
}

export const scenarios = [
  {
    name: 'health-check',
    async run(ctx) {
      const results = await requestAllTiers(ctx, (t) => t.client.get('/health'));
      return { results };
    },
  },

  {
    name: 'migration-bootstrap',
    async run(ctx) {
      const runId = Date.now();
      const keySuffix = runId.toString(36).toUpperCase();
      const results = {};
      for (const tier of ctx.tiers) {
        ctx[tier].username = `${tier}-${runId}`;
        // First letter of the tier name as the per-tier project-key suffix (n/p/m) — keeps every
        // tier's seeded key globally distinct, same reasoning as the original net/php-only "N"/"P".
        const result = await ctx[tier].client.post('/api/migration/projects', migrationFixture(ctx[tier].username, `${keySuffix}${tier[0].toUpperCase()}`));
        results[tier] = result;
        if (result.status === 200) ctx[tier].projectId = result.body?.projectId;
      }
      return { results };
    },
  },

  {
    name: 'login',
    async run(ctx) {
      const results = {};
      for (const tier of ctx.tiers) {
        const result = await ctx[tier].client.post('/api/auth/login', { username: `Parity Tester ${ctx[tier].username}`, password: 'EnklrTask9999!' });
        results[tier] = result;
        if (result.status === 200) {
          ctx[tier].client.setToken(result.body?.token);
          ctx[tier].currentPassword = 'EnklrTask9999!';
        }
      }
      return { results };
    },
  },

  {
    name: 'change-password',
    async run(ctx) {
      // Migration-seeded users always have MustChangePassword: true on every tier (confirmed
      // identical across all Service ports) — this scenario always fires, not conditionally.
      const body = { currentPassword: 'EnklrTask9999!', newPassword: 'enklUserPasswordChanged1' };
      const results = {};
      for (const tier of ctx.tiers) {
        const result = await ctx[tier].client.post('/api/auth/change-password', body);
        results[tier] = result;
        if (result.status === 200) ctx[tier].client.setToken(result.body?.token);
      }
      return { results };
    },
  },

  {
    name: 'list-projects',
    async run(ctx) {
      const results = await requestAllTiers(ctx, (t) => t.client.get('/api/projects'));
      return { results };
    },
  },

  {
    name: 'project-detail',
    async run(ctx) {
      const results = await requestAllTiers(ctx, (t) => t.client.get(`/api/projects/${t.projectId}`));
      for (const tier of ctx.tiers) {
        if (results[tier].status === 200) ctx[tier].columnId = results[tier].body?.columns?.[0]?.id;
      }
      return { results };
    },
  },

  {
    name: 'create-task',
    async run(ctx) {
      const results = await requestAllTiers(ctx, (t) =>
        t.client.post(`/api/projects/${t.projectId}/tasks`, { title: 'Contract parity test task', priority: 'medium', columnId: t.columnId })
      );
      return { results, exactFields: ['title'] };
    },
  },

  {
    name: 'create-task-validation-error',
    async run(ctx) {
      // A well-formed but nonexistent columnId — every tier's TaskService.create resolves the column
      // by (id, projectId) and returns null when it doesn't match, which every controller turns into
      // a 400 {"message":"Invalid column."} (confirmed identical across all three ports).
      const body = { title: 'Should be rejected', priority: 'medium', columnId: '00000000-0000-0000-0000-000000000000' };
      const results = await requestAllTiers(ctx, (t) => t.client.post(`/api/projects/${t.projectId}/tasks`, body));
      return { results };
    },
  },

  {
    name: 'ai-assistant-availability-fail-open',
    async run(ctx) {
      // None of this harness's three throwaway DBs has Vendor Portal's own vendor_feature_entitlements
      // table (Vendor Portal owns/creates it, not any of these tiers - root CLAUDE.md §9's entitlement
      // section) — so this doubles as a real fail-open proof on all three tiers: `enabled: true` here
      // means the "table doesn't exist" catch path was actually exercised and worked, not skipped.
      const results = await requestAllTiers(ctx, (t) => t.client.get(`/api/projects/${t.projectId}/ai-assistant/availability`));
      return { results, exactFields: ['enabled'] };
    },
  },
];
