import express from 'express';
import session from 'express-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from './migrate.js';
import { requireAuth } from './auth.js';
import { authRouter } from './routes/auth.js';
import { dashboardRouter } from './routes/dashboard.js';
import { organisationsRouter } from './routes/organisations.js';
import { licensesRouter } from './routes/licenses.js';
import { contractsRouter } from './routes/contracts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(__dirname, '..', 'web');

const app = express();
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 12 * 60 * 60 * 1000
    }
  })
);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/api', authRouter);
app.use('/api', requireAuth, dashboardRouter);
app.use('/api', requireAuth, organisationsRouter);
app.use('/api', requireAuth, licensesRouter);
app.use('/api', requireAuth, contractsRouter);

app.use(express.static(webDir));
app.get('*', (_req, res) => res.sendFile(path.join(webDir, 'index.html')));

const port = Number(process.env.PORT || 4000);

if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET must be set.');
  process.exit(1);
}

runMigrations()
  .then(() => {
    app.listen(port, () => console.log(`Enkl Portal listening on :${port}`));
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
