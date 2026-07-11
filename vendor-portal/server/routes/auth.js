import { Router } from 'express';
import { verifyLogin } from '../auth.js';

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
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
