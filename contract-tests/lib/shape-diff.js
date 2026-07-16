"use strict";

/**
 * Compares TYPES and KEY SETS, not exact values — ids/timestamps/GUIDs legitimately differ between
 * two independently-seeded backends, so exact-value equality would make every scenario flaky by
 * design. A caller that wants an exact-value check on top of this (e.g. a title the harness itself
 * set identically on both tiers) does that separately via `exactFields` in the scenario result.
 *
 * null-vs-non-null is itself reported as a mismatch — that's a real nullability-drift signal (one
 * tier forgot to populate a field the other one does), not noise to suppress.
 */
export function shapesMatch(label, a, b, mismatches) {
  if (a === null || b === null) {
    if (a !== b) mismatches.push(`${label}: null on one tier, not the other (net=${JSON.stringify(a)}, php=${JSON.stringify(b)})`);
    return;
  }
  if (a === undefined || b === undefined) {
    mismatches.push(`${label}: present on one tier, missing on the other`);
    return;
  }

  const typeA = Array.isArray(a) ? 'array' : typeof a;
  const typeB = Array.isArray(b) ? 'array' : typeof b;
  if (typeA !== typeB) {
    mismatches.push(`${label}: type mismatch (net=${typeA}, php=${typeB})`);
    return;
  }

  if (typeA === 'array') {
    const aEmpty = a.length === 0;
    const bEmpty = b.length === 0;
    if (aEmpty !== bEmpty) {
      mismatches.push(`${label}: one tier's array is empty, the other's isn't (net.length=${a.length}, php.length=${b.length})`);
      return;
    }
    if (!aEmpty && !bEmpty) {
      shapesMatch(`${label}[0]`, a[0], b[0], mismatches);
    }
    return;
  }

  if (typeA === 'object') {
    const keysA = new Set(Object.keys(a));
    const keysB = new Set(Object.keys(b));
    for (const key of keysA) {
      if (!keysB.has(key)) mismatches.push(`${label}.${key}: present on net, missing on php`);
    }
    for (const key of keysB) {
      if (!keysA.has(key)) mismatches.push(`${label}.${key}: present on php, missing on net`);
    }
    for (const key of keysA) {
      if (keysB.has(key)) shapesMatch(`${label}.${key}`, a[key], b[key], mismatches);
    }
    return;
  }

  // Primitive: type equality only (checked above via typeof) — exact value is NOT compared here.
}

export function exactFieldsMatch(label, netBody, phpBody, exactFields, mismatches) {
  for (const path of exactFields || []) {
    const netValue = getByPath(netBody, path);
    const phpValue = getByPath(phpBody, path);
    if (netValue !== phpValue) {
      mismatches.push(`${label}.${path}: exact-value mismatch (net=${JSON.stringify(netValue)}, php=${JSON.stringify(phpValue)})`);
    }
  }
}

function getByPath(obj, path) {
  return path.split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj);
}
