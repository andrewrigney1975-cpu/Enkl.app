import { Router } from 'express';
import { pool } from '../db.js';

export const dashboardRouter = Router();

dashboardRouter.get('/dashboard', async (_req, res) => {
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
});
