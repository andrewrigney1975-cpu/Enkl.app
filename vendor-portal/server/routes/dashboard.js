import { Router } from 'express';
import { pool } from '../db.js';
import { asyncRoute } from '../asyncRoute.js';

export const dashboardRouter = Router();

dashboardRouter.get('/dashboard', asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM "Organisations")::int AS org_count,
      (SELECT COUNT(*) FROM "Users" WHERE "IsActive")::int AS active_user_count,
      (SELECT COUNT(*) FROM vendor_contracts WHERE status = 'active')::int AS active_contract_count,
      (SELECT COALESCE(SUM(
        CASE billing_frequency
          WHEN 'monthly' THEN contract_value_cents * 12
          ELSE contract_value_cents
        END
      ), 0) FROM vendor_contracts WHERE status = 'active')::bigint AS annualized_contract_value_cents
  `);

  const recentContracts = await pool.query(`
    SELECT c.id, c.name, c.status, c.start_date, c.end_date, c.contract_value_cents, c.billing_frequency, o."Name" AS org_name
    FROM vendor_contracts c
    JOIN "Organisations" o ON o."Id" = c.org_id
    ORDER BY c.updated_at DESC
    LIMIT 8
  `);

  res.json({
    ...rows[0],
    recentContracts: recentContracts.rows
  });
}));

function parseDateParam(value, fallback) {
  if (!value) return fallback;
  const d = new Date(value + 'T00:00:00Z');
  return isNaN(d.getTime()) ? fallback : d;
}

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

function addDaysUTC(d, n) {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

function daysInMonthUTC(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

function resolveRange(req) {
  const end = parseDateParam(req.query.end, new Date());
  const start = parseDateParam(req.query.start, addDaysUTC(end, -90));
  // Half-open [start, endExclusive) so the end date's own day is fully included.
  const endExclusive = addDaysUTC(end, 1);
  return { start, end, endExclusive };
}

dashboardRouter.get('/dashboard/activity', asyncRoute(async (req, res) => {
  const { start, endExclusive } = resolveRange(req);

  const [created, edited, done] = await Promise.all([
    pool.query(
      `SELECT date_trunc('day', "DateCreated") AS day, COUNT(*)::int AS n
       FROM "Tasks" WHERE "DateCreated" >= $1 AND "DateCreated" < $2 GROUP BY 1 ORDER BY 1`,
      [start, endExclusive]
    ),
    pool.query(
      `SELECT date_trunc('day', "DateLastModified") AS day, COUNT(*)::int AS n
       FROM "Tasks"
       WHERE "DateLastModified" >= $1 AND "DateLastModified" < $2 AND "DateLastModified" <> "DateCreated"
       GROUP BY 1 ORDER BY 1`,
      [start, endExclusive]
    ),
    pool.query(
      `SELECT date_trunc('day', "DateDone") AS day, COUNT(*)::int AS n
       FROM "Tasks" WHERE "DateDone" >= $1 AND "DateDone" < $2 GROUP BY 1 ORDER BY 1`,
      [start, endExclusive]
    )
  ]);

  const toSeries = (rows) => rows.map((r) => ({ date: toISODate(new Date(r.day)), count: r.n }));

  res.json({
    start: toISODate(start),
    end: toISODate(addDaysUTC(endExclusive, -1)),
    created: toSeries(created.rows),
    edited: toSeries(edited.rows),
    done: toSeries(done.rows)
  });
}));

dashboardRouter.get('/dashboard/revenue', asyncRoute(async (req, res) => {
  const { start, endExclusive } = resolveRange(req);

  const [contracts, licenses] = await Promise.all([
    pool.query(
      `SELECT contract_value_cents, billing_frequency, start_date, end_date
       FROM vendor_contracts
       WHERE status = 'active'
         AND (start_date IS NULL OR start_date < $2)
         AND (end_date IS NULL OR end_date >= $1)`,
      [start, endExclusive]
    ),
    // seat_cost_cents is a monthly per-seat rate (matches the "/ seat" label with no other
    // period shown in licenses.js) — spread across each month's days just like monthly contracts.
    pool.query(
      `SELECT l.seat_cost_cents, l.discount_percent, l.effective_from,
              (SELECT COUNT(*) FROM "Users" u WHERE u."OrganisationId" = l.org_id AND u."IsActive")::int AS active_user_count
       FROM vendor_licenses l
       WHERE l.effective_from IS NULL OR l.effective_from < $1`,
      [endExclusive]
    )
  ]);

  const dayCents = new Map();
  for (let d = new Date(start); d.getTime() < endExclusive.getTime(); d = addDaysUTC(d, 1)) {
    dayCents.set(toISODate(d), 0);
  }

  for (const c of contracts.rows) {
    const cStart = c.start_date ? new Date(c.start_date) : start;
    const cEnd = c.end_date ? addDaysUTC(new Date(c.end_date), 1) : endExclusive;
    if (c.billing_frequency === 'one_time') {
      const key = toISODate(cStart);
      if (dayCents.has(key)) dayCents.set(key, dayCents.get(key) + c.contract_value_cents);
      continue;
    }
    const monthlyAmount = c.billing_frequency === 'annual' ? c.contract_value_cents / 12 : c.contract_value_cents;
    for (let d = new Date(Math.max(cStart.getTime(), start.getTime())); d.getTime() < Math.min(cEnd.getTime(), endExclusive.getTime()); d = addDaysUTC(d, 1)) {
      const key = toISODate(d);
      if (dayCents.has(key)) dayCents.set(key, dayCents.get(key) + monthlyAmount / daysInMonthUTC(d));
    }
  }

  for (const l of licenses.rows) {
    const lStart = l.effective_from ? new Date(l.effective_from) : start;
    const monthlyAmount = l.seat_cost_cents * l.active_user_count * (1 - Number(l.discount_percent) / 100);
    for (let d = new Date(Math.max(lStart.getTime(), start.getTime())); d.getTime() < endExclusive.getTime(); d = addDaysUTC(d, 1)) {
      const key = toISODate(d);
      if (dayCents.has(key)) dayCents.set(key, dayCents.get(key) + monthlyAmount / daysInMonthUTC(d));
    }
  }

  const days = Array.from(dayCents.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, cents]) => ({ date, revenue_cents: Math.round(cents) }));

  res.json({
    start: toISODate(start),
    end: toISODate(addDaysUTC(endExclusive, -1)),
    currency: 'AUD',
    days
  });
}));
