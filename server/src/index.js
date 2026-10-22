require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const assetsRoutes = require('./routes/assets');
const beneficiariesRoutes = require('./routes/beneficiaries');
const instructionsRoutes = require('./routes/instructions');
const messagesRoutes = require('./routes/messages');
const auditRoutes = require('./routes/audit');
const securityRoutes = require('./routes/security');

const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || '*',
  })
);
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/assets', assetsRoutes);
app.use('/api/beneficiaries', beneficiariesRoutes);
app.use('/api/instructions', instructionsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/security', securityRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Central error handler — anything an asyncHandler-wrapped route forwards
// via next(err) lands here instead of leaking a stack trace to the client.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Digital Legacy Manager API listening on http://localhost:${PORT}`);
});
