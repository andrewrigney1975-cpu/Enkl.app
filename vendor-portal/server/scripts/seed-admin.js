import bcrypt from 'bcrypt';
import { pool } from '../db.js';
import { runMigrations } from '../migrate.js';

const [username, password] = process.argv.slice(2);

if (!username || !password) {
  console.error('Usage: node server/scripts/seed-admin.js <username> <password>');
  process.exit(1);
}

// Security review (Low/Informational finding): length alone let straight through anything
// >=12 chars, including "aaaaaaaaaaaa" or a repeated dictionary word. No external dependency (this
// is a one-time CLI bootstrap tool, not a public registration form) — a small hardcoded weak-list
// plus a basic character-class-diversity check, same "no external dependency" convention as this
// codebase's other hardcoded lists (e.g. PrincipleService's Stopwords set).
const COMMON_WEAK_PASSWORDS = new Set([
  'password123', 'passw0rd123', 'letmein12345', 'welcome12345', 'admin12345678',
  'qwertyuiop123', 'changeme12345', 'administrator1', '123456789012', 'iloveyou12345'
]);

if (password.length < 12) {
  console.error('Password must be at least 12 characters.');
  process.exit(1);
}
if (password.toLowerCase() === username.toLowerCase()) {
  console.error('Password must not be the same as the username.');
  process.exit(1);
}
if (COMMON_WEAK_PASSWORDS.has(password.toLowerCase())) {
  console.error('That password is too common. Choose something less guessable.');
  process.exit(1);
}
const classCount = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length;
if (classCount < 3) {
  console.error('Password must mix at least 3 of: lowercase, uppercase, digits, symbols.');
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
