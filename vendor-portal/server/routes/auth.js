import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { verifyLogin } from '../auth.js';

export const authRouter = Router();

// Security review finding H1: this is the single admin login for the whole portal with no prior
// brute-force protection at all. Keyed by IP (express-rate-limit's default), not username, so an
// attacker can't dodge the limit by cycling through guessed usernames against the one real account.
const loginRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a moment and try again.' }
});

authRouter.post('/login', loginRateLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const admin = await verifyLogin(username, password);
  if (!admin) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  req.session.adminId = admin.id;
  req.session.username = admin.username;
  res.json({ username: admin.username, mustChangePassword: admin.mustChangePassword });
});

authRouter.post('/logout', (req, res) => {
  req.session.destroy(() => res.status(204).end());
});

authRouter.get('/session', (req, res) => {
  if (!req.session.adminId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json({ username: req.session.username });
});
