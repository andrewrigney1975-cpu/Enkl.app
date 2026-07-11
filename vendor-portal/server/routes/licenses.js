import { Router } from 'express';
import { pool } from '../db.js';
import { asyncRoute } from '../asyncRoute.js';

export const licensesRouter = Router();

function validateLicense(body) {
  const seatCostCents = Math.round(Number(body.seatCostCents));
  const discountPercent = Number(body.discountPercent ?? 0);
  const currency = String(body.currency || 'USD').trim().slice(0, 8).toUpperCase();

  if (!Number.isFinite(seatCostCents) || seatCostCents < 0) {
    return { error: 'seatCostCents must be a non-negative number.' };
  }
  if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    return { error: 'discountPercent must be between 0 and 100.' };
  }
  return {
    seatCostCents,
    discountPercent,
    currency,
    effectiveFrom: body.effectiveFrom || null,
    notes: body.notes ? String(body.notes).slice(0, 2000) : null
  };
}

licensesRouter.put('/organisations/:id/license', asyncRoute(async (req, res) => {
  const parsed = validateLicense(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const { rows } = await pool.query(
    `
    INSERT INTO vendor_licenses (org_id, seat_cost_cents, currency, discount_percent, effective_from, notes, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, now())
    ON CONFLICT (org_id) DO UPDATE SET
      seat_cost_cents = EXCLUDED.seat_cost_cents,
      currency = EXCLUDED.currency,
      discount_percent = EXCLUDED.discount_percent,
      effective_from = EXCLUDED.effective_from,
      notes = EXCLUDED.notes,
      updated_at = now()
    RETURNING *
    `,
    [req.params.id, parsed.seatCostCents, parsed.currency, parsed.discountPercent, parsed.effectiveFrom, parsed.notes]
  );

  res.json(rows[0]);
}));

licensesRouter.delete('/organisations/:id/license', asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM vendor_licenses WHERE org_id = $1', [req.params.id]);
  res.status(204).end();
}));
