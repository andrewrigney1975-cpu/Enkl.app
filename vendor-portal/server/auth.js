import bcrypt from 'bcrypt';
import { pool } from './db.js';

// Security review finding M1: the not-found path used to return immediately, skipping bcrypt
// entirely, while the wrong-password path always paid its cost — a timing side-channel letting an
// attacker distinguish "no such admin" from "admin exists, wrong password" by response time alone.
// Computed once at module load (not per-request) so the dummy compare below costs the same as a real
// one without re-hashing on every failed login attempt.
// Cost factor 12 to match seed-admin.js's real hashing cost — a mismatched factor would reintroduce
// a (smaller) timing gap between the dummy and real compare.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('dummy-password-for-timing-normalization', 12);

export async function verifyLogin(username, password) {
  const { rows } = await pool.query(
    'SELECT id, username, password_hash, must_change_password FROM vendor_admin WHERE username = $1',
    [username]
  );
  const admin = rows[0];
  if (!admin) {
    await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
    return null;
  }

  const ok = await bcrypt.compare(password, admin.password_hash);
  if (!ok) return null;

  return { id: admin.id, username: admin.username, mustChangePassword: admin.must_change_password };
}

export function requireAuth(req, res, next) {
  if (!req.session.adminId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}
