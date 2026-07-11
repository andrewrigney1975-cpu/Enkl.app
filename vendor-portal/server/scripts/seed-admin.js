import bcrypt from 'bcrypt';
import { pool } from '../db.js';
import { runMigrations } from '../migrate.js';

const [username, password] = process.argv.slice(2);

if (!username || !password) {
  console.error('Usage: node server/scripts/seed-admin.js <username> <password>');
  process.exit(1);
}

if (password.length < 12) {
  console.error('Password must be at least 12 characters.');
  process.exit(1);
}

await runMigrations();

const passwordHash = await bcrypt.hash(password, 12);

// Enkl Portal has exactly one user — replace whatever row exists rather than accumulating rows.
await pool.query('DELETE FROM vendor_admin');
await pool.query(
  'INSERT INTO vendor_admin (username, password_hash, must_change_password) VALUES ($1, $2, false)',
  [username, passwordHash]
);

console.log(`[seed-admin] admin user '${username}' set.`);
await pool.end();
