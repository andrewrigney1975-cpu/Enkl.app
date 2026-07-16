"use strict";

/**
 * ARCHITECTURE-REVIEW.md finding #3 — fires the same requests at both backend tiers and diffs
 * status/JSON shape (see scenarios.js). Both tiers must already be running before this is invoked;
 * see .github/workflows/ci.yml's `contract-parity` job for how CI boots them, or CLAUDE.md's testing
 * conventions for how to run this the same way locally (two throwaway Postgres instances, `dotnet
 * run` for the .NET tier, `php -S ... -t public` for the PHP tier).
 *
 * Usage: NET_BASE_URL=http://localhost:8080 PHP_BASE_URL=http://localhost:8081 node run-parity.js
 */

import { createClient, waitForHealth } from './lib/http-client.js';
import { shapesMatch, exactFieldsMatch } from './lib/shape-diff.js';
import { scenarios } from './scenarios.js';

const NET_BASE_URL = process.env.NET_BASE_URL || 'http://localhost:8080';
const PHP_BASE_URL = process.env.PHP_BASE_URL || 'http://localhost:8081';

async function main() {
  process.stdout.write(`\nWaiting for both tiers to be healthy (net=${NET_BASE_URL}, php=${PHP_BASE_URL})...\n`);
  await Promise.all([waitForHealth(NET_BASE_URL), waitForHealth(PHP_BASE_URL)]);

  const ctx = {
    net: { client: createClient(NET_BASE_URL) },
    php: { client: createClient(PHP_BASE_URL) },
  };

  process.stdout.write(`\nRunning ${scenarios.length} contract-parity scenarios...\n\n`);

  let totalPass = 0;
  let totalFail = 0;
  const failedScenarios = [];

  for (const scenario of scenarios) {
    const mismatches = [];

    try {
      const { netResult, phpResult, exactFields } = await scenario.run(ctx);

      if (netResult.status !== phpResult.status) {
        mismatches.push(`status: net=${netResult.status}, php=${phpResult.status}`);
      } else {
        shapesMatch('body', netResult.body, phpResult.body, mismatches);
        exactFieldsMatch('body', netResult.body, phpResult.body, exactFields, mismatches);
      }
    } catch (err) {
      mismatches.push(`scenario threw: ${err.stack || err}`);
    }

    if (mismatches.length === 0) {
      totalPass++;
      process.stdout.write('  pass  ' + scenario.name + '\n');
    } else {
      totalFail++;
      failedScenarios.push(scenario.name);
      process.stdout.write('  FAIL  ' + scenario.name + '\n');
      mismatches.forEach((m) => process.stdout.write('         - ' + m + '\n'));
    }
  }

  process.stdout.write('\n' + '─'.repeat(65) + '\n');
  process.stdout.write(`TOTAL: ${totalPass} pass, ${totalFail} fail (${scenarios.length} scenarios)\n`);
  if (failedScenarios.length > 0) {
    process.stdout.write('\nFailed scenarios: ' + failedScenarios.join(', ') + '\n');
  }

  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write('Fatal error running contract-parity harness: ' + (err.stack || err) + '\n');
  process.exit(1);
});
