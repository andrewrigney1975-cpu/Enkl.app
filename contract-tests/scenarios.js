"use strict";

/**
 * Ordered scenarios sharing one `ctx` across the run (tokens/ids seeded by earlier scenarios feed
 * later ones — a fresh org/project only exists once the migration-bootstrap scenario has run).
 *
 * Each `run(ctx)` fires the SAME logical request at both tiers via ctx.net.client/ctx.php.client and
 * returns { netResult: {status, body}, phpResult: {status, body}, exactFields? }. The runner (see
 * run-parity.js) does the actual status/shape diffing — scenarios just describe what to call and,
 * optionally, which response fields should be byte-for-byte identical (only true for values the
 * harness itself set identically on both tiers, like a task title).
 *
 * To add a scenario: push a new { name, run } onto this array. It runs after everything already
 * here, with ctx already carrying whatever earlier scenarios stashed on it.
 *
 * Deliberately NOT covered yet (documented, not attempted, this pass): the SSE stream endpoint
 * (long-lived connection, a different testing shape entirely) and SAML/SCIM (need an external
 * IdP/SCIM client to exercise meaningfully).
 */

function migrationFixture(runSuffix, keySuffix) {
  const key = `CP${keySuffix}`;
  return {
    organisationName: `ContractParity-${runSuffix}`,
    // Project.Key has a GLOBAL unique index (IX_Projects_Key on both tiers' schemas — not scoped per
    // organisation), so this has to vary per run just like the org/member names below, or a repeat
    // run against a persistent DB 409s on the second attempt.
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
      const [netResult, phpResult] = await Promise.all([ctx.net.client.get('/health'), ctx.php.client.get('/health')]);
      return { netResult, phpResult };
    },
  },

  {
    name: 'migration-bootstrap',
    async run(ctx) {
      const runId = Date.now();
      const keySuffix = runId.toString(36).toUpperCase();
      ctx.net.username = `net-${runId}`;
      ctx.php.username = `php-${runId}`;
      const netResult = await ctx.net.client.post('/api/migration/projects', migrationFixture(ctx.net.username, `${keySuffix}N`));
      const phpResult = await ctx.php.client.post('/api/migration/projects', migrationFixture(ctx.php.username, `${keySuffix}P`));

      if (netResult.status === 200) ctx.net.projectId = netResult.body?.projectId;
      if (phpResult.status === 200) ctx.php.projectId = phpResult.body?.projectId;

      return { netResult, phpResult };
    },
  },

  {
    name: 'login',
    async run(ctx) {
      const netResult = await ctx.net.client.post('/api/auth/login', { username: `Parity Tester ${ctx.net.username}`, password: 'enklUserPassword' });
      const phpResult = await ctx.php.client.post('/api/auth/login', { username: `Parity Tester ${ctx.php.username}`, password: 'enklUserPassword' });

      if (netResult.status === 200) {
        ctx.net.client.setToken(netResult.body?.token);
        ctx.net.currentPassword = 'enklUserPassword';
      }
      if (phpResult.status === 200) {
        ctx.php.client.setToken(phpResult.body?.token);
        ctx.php.currentPassword = 'enklUserPassword';
      }

      return { netResult, phpResult };
    },
  },

  {
    name: 'change-password',
    async run(ctx) {
      // Migration-seeded users always have MustChangePassword: true on both tiers (confirmed
      // identical in MigrationService.cs/.php) — this scenario always fires, not conditionally.
      const body = { currentPassword: 'enklUserPassword', newPassword: 'enklUserPasswordChanged1' };
      const netResult = await ctx.net.client.post('/api/auth/change-password', body);
      const phpResult = await ctx.php.client.post('/api/auth/change-password', body);

      if (netResult.status === 200) ctx.net.client.setToken(netResult.body?.token);
      if (phpResult.status === 200) ctx.php.client.setToken(phpResult.body?.token);

      return { netResult, phpResult };
    },
  },

  {
    name: 'list-projects',
    async run(ctx) {
      const [netResult, phpResult] = await Promise.all([ctx.net.client.get('/api/projects'), ctx.php.client.get('/api/projects')]);
      return { netResult, phpResult };
    },
  },

  {
    name: 'project-detail',
    async run(ctx) {
      const [netResult, phpResult] = await Promise.all([
        ctx.net.client.get(`/api/projects/${ctx.net.projectId}`),
        ctx.php.client.get(`/api/projects/${ctx.php.projectId}`),
      ]);

      if (netResult.status === 200) ctx.net.columnId = netResult.body?.columns?.[0]?.id;
      if (phpResult.status === 200) ctx.php.columnId = phpResult.body?.columns?.[0]?.id;

      return { netResult, phpResult };
    },
  },

  {
    name: 'create-task',
    async run(ctx) {
      const body = (columnId) => ({ title: 'Contract parity test task', priority: 'medium', columnId });
      const [netResult, phpResult] = await Promise.all([
        ctx.net.client.post(`/api/projects/${ctx.net.projectId}/tasks`, body(ctx.net.columnId)),
        ctx.php.client.post(`/api/projects/${ctx.php.projectId}/tasks`, body(ctx.php.columnId)),
      ]);
      return { netResult, phpResult, exactFields: ['title'] };
    },
  },

  {
    name: 'create-task-validation-error',
    async run(ctx) {
      // A well-formed but nonexistent columnId — both tiers' TaskService.create resolves the column
      // by (id, projectId) and returns null when it doesn't match, which both controllers turn into
      // a 400 {"message":"Invalid column."} (confirmed identical in TaskService.cs/.php).
      const body = { title: 'Should be rejected', priority: 'medium', columnId: '00000000-0000-0000-0000-000000000000' };
      const [netResult, phpResult] = await Promise.all([
        ctx.net.client.post(`/api/projects/${ctx.net.projectId}/tasks`, body),
        ctx.php.client.post(`/api/projects/${ctx.php.projectId}/tasks`, body),
      ]);
      return { netResult, phpResult };
    },
  },
];
