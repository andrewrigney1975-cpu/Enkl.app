import bcrypt from 'bcrypt';
import { pool } from './db.js';

export async function verifyLogin(username, password) {
  const { rows } = await pool.query(
    'SELECT id, username, password_hash, must_change_password FROM vendor_admin WHERE username = $1',
    [username]
  );
  const admin = rows[0];
  if (!admin) return null;

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
