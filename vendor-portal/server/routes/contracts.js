import { Router } from 'express';
import { pool } from '../db.js';
import { asyncRoute } from '../asyncRoute.js';

export const contractsRouter = Router();

const STATUSES = ['draft', 'active', 'expired', 'cancelled'];
const FREQUENCIES = ['monthly', 'annual', 'one_time'];

function validateContract(body) {
  const name = String(body.name || '').trim().slice(0, 200);
  const status = STATUSES.includes(body.status) ? body.status : 'draft';
  const billingFrequency = FREQUENCIES.includes(body.billingFrequency) ? body.billingFrequency : 'annual';
  const contractValueCents = Math.round(Number(body.contractValueCents));

  if (!name) return { error: 'name is required.' };
  if (!Number.isFinite(contractValueCents) || contractValueCents < 0) {
    return { error: 'contractValueCents must be a non-negative number.' };
  }

  return {
    name,
    status,
    billingFrequency,
    contractValueCents,
    startDate: body.startDate || null,
    endDate: body.endDate || null,
    notes: body.notes ? String(body.notes).slice(0, 2000) : null
  };
}

contractsRouter.post('/organisations/:id/contracts', asyncRoute(async (req, res) => {
  const parsed = validateContract(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const { rows } = await pool.query(
    `
    INSERT INTO vendor_contracts (org_id, name, status, start_date, end_date, contract_value_cents, billing_frequency, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
    `,
    [req.params.id, parsed.name, parsed.status, parsed.startDate, parsed.endDate, parsed.contractValueCents, parsed.billingFrequency, parsed.notes]
  );

  res.status(201).json(rows[0]);
}));

contractsRouter.put('/contracts/:contractId', asyncRoute(async (req, res) => {
  const parsed = validateContract(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const { rows } = await pool.query(
    `
    UPDATE vendor_contracts SET
      name = $2, status = $3, start_date = $4, end_date = $5,
      contract_value_cents = $6, billing_frequency = $7, notes = $8, updated_at = now()
    WHERE id = $1
    RETURNING *
    `,
    [req.params.contractId, parsed.name, parsed.status, parsed.startDate, parsed.endDate, parsed.contractValueCents, parsed.billingFrequency, parsed.notes]
  );

  if (!rows[0]) return res.status(404).json({ error: 'Contract not found.' });
  res.json(rows[0]);
}));

contractsRouter.delete('/contracts/:contractId', asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM vendor_contracts WHERE id = $1', [req.params.contractId]);
  res.status(204).end();
}));
