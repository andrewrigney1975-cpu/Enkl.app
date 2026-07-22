import { Router } from 'express';
import { pool } from '../db.js';
import { asyncRoute } from '../asyncRoute.js';

export const announcementsRouter = Router();

/* Vendor Portal's write path into the main app's shared "Announcements" table (Phase 2 of the
   Announcements feature — see the main app's own root CLAUDE.md for the full Scope design). This
   table is owned/migrated by the main app's own backend tiers, not this portal — same established
   pattern as this app's existing reads of "Organisations"/"Users"/"Tasks" (raw SQL,
   quoted-PascalCase-column-name, no migration of its own needed here). Every row this portal ever
   writes is CreatedByVendor=true, CreatedByUserId=NULL — this admin's own identity isn't tracked
   per-row (no per-admin accounts, see auth.js), matching every other vendor-authored action here. */

const KINDS = ['announcement', 'disruption'];

function validateAnnouncement(body) {
  const title = String(body.title || '').trim().slice(0, 200);
  const kind = KINDS.includes(body.kind) ? body.kind : 'announcement';
  const scope = body.scope === 'platform' ? 'platform' : 'orgs';
  const orgIds = Array.isArray(body.orgIds) ? body.orgIds.filter((id) => typeof id === 'string' && id) : [];

  if (!title) return { error: 'title is required.' };
  if (!body.startAt || Number.isNaN(Date.parse(body.startAt))) {
    return { error: 'A valid start date/time is required.' };
  }
  if (body.endAt && Number.isNaN(Date.parse(body.endAt))) {
    return { error: 'End date/time is invalid.' };
  }
  if (scope === 'orgs' && orgIds.length === 0) {
    return { error: 'Choose at least one organisation, or switch to platform-wide.' };
  }

  return {
    title,
    body: body.body ? String(body.body).slice(0, 10000) : '',
    kind,
    scope,
    orgIds,
    startAt: body.startAt,
    endAt: body.endAt || null
  };
}

// Vendor-authored rows only (CreatedByVendor=true) — an Org Admin's own Scope='org' rows (created
// from inside the main app itself) are that organisation's own business, not shown/managed here.
announcementsRouter.get('/announcements', asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT
      a."Id" AS id, a."Scope" AS scope, a."Title" AS title, a."Body" AS body, a."Kind" AS kind,
      a."StartAt" AS start_at, a."EndAt" AS end_at, a."DateCreated" AS date_created,
      (SELECT array_agg(ao."OrganisationId") FROM "AnnouncementOrganisations" ao WHERE ao."AnnouncementId" = a."Id") AS org_ids,
      (SELECT string_agg(o."Name", ', ' ORDER BY o."Name")
       FROM "AnnouncementOrganisations" ao2 JOIN "Organisations" o ON o."Id" = ao2."OrganisationId"
       WHERE ao2."AnnouncementId" = a."Id") AS org_names
    FROM "Announcements" a
    WHERE a."CreatedByVendor" = true
    ORDER BY a."DateCreated" DESC
  `);
  res.json(rows);
}));

announcementsRouter.post('/announcements', asyncRoute(async (req, res) => {
  const parsed = validateAnnouncement(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `
      INSERT INTO "Announcements"
        ("Id", "Scope", "OrganisationId", "Title", "Body", "Kind", "StartAt", "EndAt",
         "CreatedByUserId", "CreatedByVendor", "DateCreated", "DateLastModified")
      VALUES (gen_random_uuid(), $1, NULL, $2, $3, $4, $5, $6, NULL, true, now(), now())
      RETURNING "Id" AS id
      `,
      [parsed.scope, parsed.title, parsed.body, parsed.kind, parsed.startAt, parsed.endAt]
    );
    const announcementId = rows[0].id;

    if (parsed.scope === 'orgs') {
      for (const orgId of parsed.orgIds) {
        await client.query(
          'INSERT INTO "AnnouncementOrganisations" ("Id", "AnnouncementId", "OrganisationId") VALUES (gen_random_uuid(), $1, $2)',
          [announcementId, orgId]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ id: announcementId });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

announcementsRouter.put('/announcements/:id', asyncRoute(async (req, res) => {
  const parsed = validateAnnouncement(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `
      UPDATE "Announcements"
      SET "Scope" = $2, "Title" = $3, "Body" = $4, "Kind" = $5, "StartAt" = $6, "EndAt" = $7, "DateLastModified" = now()
      WHERE "Id" = $1 AND "CreatedByVendor" = true
      RETURNING "Id" AS id
      `,
      [req.params.id, parsed.scope, parsed.title, parsed.body, parsed.kind, parsed.startAt, parsed.endAt]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Announcement not found.' });
    }

    await client.query('DELETE FROM "AnnouncementOrganisations" WHERE "AnnouncementId" = $1', [req.params.id]);
    if (parsed.scope === 'orgs') {
      for (const orgId of parsed.orgIds) {
        await client.query(
          'INSERT INTO "AnnouncementOrganisations" ("Id", "AnnouncementId", "OrganisationId") VALUES (gen_random_uuid(), $1, $2)',
          [req.params.id, orgId]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ id: req.params.id });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

announcementsRouter.delete('/announcements/:id', asyncRoute(async (req, res) => {
  // AnnouncementOrganisations/AnnouncementAcknowledgements both cascade-delete on Announcements FK
  // (see the main app's own migration) — no separate cleanup needed here.
  await pool.query('DELETE FROM "Announcements" WHERE "Id" = $1 AND "CreatedByVendor" = true', [req.params.id]);
  res.status(204).end();
}));
