#!/usr/bin/env node
/* run_all_tests.js — runs every *_test.js in this directory (in parallel, via a bounded worker pool)
   and prints a summary in the same file order/format the old sequential runner used.
   Usage: node run_all_tests.js [--concurrency=N] [--retry-concurrency=N] */
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const testFiles = fs.readdirSync(dir)
  .filter(f => f.endsWith('_test.js'))
  .sort();

function argNumber(flag, fallback) {
  const arg = process.argv.find(a => a.startsWith(flag + '='));
  return arg ? Math.max(1, parseInt(arg.split('=')[1], 10) || fallback) : fallback;
}

// Each file is already fully isolated (its own subprocess, its own fresh JSDOM, no shared state with
// any other file), so running several at once is safe correctness-wise. Capped well below the raw
// core count by default (each JSDOM instance loading the full 1.3MB+ bundle is real memory/CPU weight
// per worker). Override with --concurrency=N if this machine can comfortably take more (or less).
const CONCURRENCY = argNumber('--concurrency', Math.max(1, Math.min(os.cpus().length, 8)));
// Retries run at a MUCH lower concurrency than the first pass — see runAllRounds' own comment for why
// this two-phase shape exists at all (a naive single-pool retry made the suite's flake rate far worse,
// not better, confirmed live: the first version of this parallel runner retried a failing file while
// 7 OTHER files were still hammering the CPU in the same pool, so the retry never actually got the
// "quiet" conditions a human's own manual re-run, or the old sequential runner's later-stage retries,
// used to reliably get).
const RETRY_CONCURRENCY = argNumber('--retry-concurrency', 2);

// Every file in this suite boots a fresh JSDOM against the full bundled dist/index.html (now 1.3MB+,
// see CLAUDE.md's Advanced Query/AlaSQL note) and relies on fixed-millisecond wait()s for that boot
// to finish - inherently timing-sensitive, and worse under whatever load this machine (or a CI
// runner) happens to be under at the moment a given file's subprocess spawns. This is the suite's
// own long-documented "batch flake": a file that fails in the full sweep but passes standalone,
// non-deterministically - a DIFFERENT random subset fails from one full run to the next, confirmed
// live (30 fails one run, 90 fails covering a mostly disjoint file set the next, no code change in
// between). Previously the documented fix was a human re-running the specific file 3x by hand before
// trusting a red result; MAX_ATTEMPTS formalizes exactly that inside the runner itself, so a flaky
// file that eventually passes doesn't fail the whole suite (and CI) on a non-regression, while a
// genuinely broken file - which fails the same way on every attempt - still fails for real.
var MAX_ATTEMPTS = 3;

function runOnce(file) {
  return new Promise(function(resolve) {
    const child = spawn(process.execPath, [path.join(dir, file)], { cwd: dir });
    var stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(function(){ timedOut = true; child.kill(); }, 120000);
    child.stdout.on('data', function(d){ stdout += d; });
    child.stderr.on('data', function(d){ stderr += d; });
    child.on('close', function(code){
      clearTimeout(timer);
      const pass = (stdout.match(/^PASS/gm) || []).length;
      const fail = (stdout.match(/^FAIL/gm) || []).length;
      const crashed = timedOut || (code !== 0 && fail === 0);
      resolve({ stdout, stderr, pass, fail, crashed });
    });
  });
}

// Runs exactly one attempt of each given file, at the given concurrency, reporting progress as each
// one finishes. Returns results in the SAME order as `files`.
async function runBatch(files, concurrency, onProgress) {
  const results = new Array(files.length);
  var nextIndex = 0, completed = 0;
  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= files.length) return;
      results[i] = await runOnce(files[i]);
      completed++;
      if (onProgress) onProgress(completed, files.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return results;
}

// Phase 1: every file, once, at full concurrency — this is where the wall-clock win comes from.
// Phase 2+: only whatever failed/crashed in the previous round, at RETRY_CONCURRENCY (far gentler),
// up to MAX_ATTEMPTS total attempts per file. A file's later attempts genuinely need calmer
// conditions to prove anything (that's the whole premise of a retry-for-flake mechanism at all) — see
// the RETRY_CONCURRENCY comment above for the failure mode this avoids.
async function runAllRounds() {
  const state = testFiles.map(function(file) { return { file: file, attemptsUsed: 0, result: null }; });
  var pendingIndices = state.map(function(_, i) { return i; });
  var round = 0;

  while (pendingIndices.length > 0 && round < MAX_ATTEMPTS) {
    const concurrency = round === 0 ? CONCURRENCY : RETRY_CONCURRENCY;
    const label = round === 0 ? 'Running ' + pendingIndices.length + ' test files (concurrency=' + concurrency + ')...'
      : 'Retrying ' + pendingIndices.length + ' file(s) that failed (concurrency=' + concurrency + ', attempt ' + (round + 1) + '/' + MAX_ATTEMPTS + ')...';
    process.stdout.write('\n' + label + '\n\n');

    const files = pendingIndices.map(function(i) { return testFiles[i]; });
    const results = await runBatch(files, concurrency, function(completed, total) {
      process.stdout.write('\r  ' + completed + '/' + total + ' complete...   ');
    });
    process.stdout.write('\r' + ' '.repeat(40) + '\r');

    pendingIndices.forEach(function(idx, j) {
      state[idx].result = results[j];
      state[idx].attemptsUsed++;
    });
    round++;
    pendingIndices = pendingIndices.filter(function(idx) {
      return state[idx].result.fail > 0 || state[idx].result.crashed;
    });
  }

  return state.map(function(s) {
    const flaky = s.attemptsUsed > 1 && s.result.fail === 0 && !s.result.crashed;
    return Object.assign({ file: s.file, attemptsUsed: s.attemptsUsed, flaky: flaky }, s.result);
  });
}

async function main() {
  const results = await runAllRounds();

  // Printed in the same sorted file order the old sequential runner used, regardless of which round
  // a given file was finally resolved in.
  var totalPass = 0, totalFail = 0;
  const flakyFiles = [];
  results.forEach(function(r) {
    totalPass += r.pass;
    totalFail += r.fail;
    if (r.flaky) flakyFiles.push(r);

    const status = r.crashed ? '  CRASH ' : (r.fail > 0 ? '  FAIL  ' : (r.flaky ? '  FLAKY ' : '  pass  '));
    const detail = (r.pass + '/' + (r.pass + r.fail)) + (r.flaky ? ' (passed on attempt ' + r.attemptsUsed + '/' + MAX_ATTEMPTS + ')' : '');
    process.stdout.write(status + r.file.padEnd(55) + detail + '\n');

    if (r.fail > 0) {
      r.stdout.split('\n').filter(function(l){ return l.startsWith('FAIL'); }).forEach(function(l){
        process.stdout.write('         ' + l + '\n');
      });
    }
    if (r.crashed) {
      process.stdout.write('         ' + (r.stderr || '(no stderr)').slice(0, 200) + '\n');
    }
    if ((r.fail > 0 || r.crashed) && r.attemptsUsed >= MAX_ATTEMPTS) {
      process.stdout.write('         (failed on all ' + MAX_ATTEMPTS + ' attempts - not batch flake)\n');
    }
  });

  process.stdout.write('\n' + '─'.repeat(65) + '\n');
  process.stdout.write('TOTAL: ' + totalPass + ' pass, ' + totalFail + ' fail  (' + testFiles.length + ' files)\n');
  if (flakyFiles.length > 0) {
    process.stdout.write(flakyFiles.length + ' file(s) needed a retry to pass (batch flake, not a regression): ' +
      flakyFiles.map(function(r){ return r.file; }).join(', ') + '\n');
  }

  if (totalFail > 0) {
    process.stdout.write('\nFailed files (failed on all ' + MAX_ATTEMPTS + ' attempts - a real regression, not batch flake):\n');
    results.filter(function(r){ return r.fail > 0 || r.crashed; }).forEach(function(r){
      process.stdout.write('  ' + r.file + (r.crashed ? ' (CRASHED)' : ' (' + r.fail + ' failing)') + '\n');
    });
  }

  process.exit(totalFail > 0 ? 1 : 0);
}

main();
