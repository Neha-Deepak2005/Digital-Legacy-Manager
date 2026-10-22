const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db/pool');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { issueOtp, verifyOtp } = require('../utils/otp');
const { signToken } = require('../utils/jwt');
const { isValidEmail, describeDevice } = require('../utils/validators');
const { addAudit } = require('../utils/audit');
const { serializeUser, serializeSecurity } = require('../utils/serialize');

const router = express.Router();
const RESET_TOKEN_SECRET = process.env.JWT_SECRET || 'dev-only-change-me-please';

async function findUserByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  return rows[0] || null;
}

async function findUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createSession(userId, req) {
  const device = describeDevice(req.headers['user-agent']);
  const ip = req.ip || req.socket?.remoteAddress || 'Unknown';
  const { rows } = await pool.query(
    `INSERT INTO sessions (user_id, device, ip) VALUES ($1, $2, $3) RETURNING id`,
    [userId, device, ip]
  );
  return rows[0].id;
}

// ---------- signup ----------
router.post(
  '/signup',
  asyncHandler(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');

    if (!name) return res.status(400).json({ error: 'Enter your name.' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });

    const existing = await findUserByEmail(email);
    if (existing && existing.email_verified) {
      return res.status(409).json({ error: 'An account with this email already exists. Try logging in instead.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    let userId;
    if (existing) {
      // Unverified account retrying signup — update details and re-issue a code.
      await pool.query('UPDATE users SET name = $1, password_hash = $2 WHERE id = $3', [
        name,
        passwordHash,
        existing.id,
      ]);
      userId = existing.id;
    } else {
      const { rows } = await pool.query(
        `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id`,
        [name, email, passwordHash]
      );
      userId = rows[0].id;
    }

    const otp = await issueOtp(pool, userId, 'signup');
    res.json({
      userId,
      email,
      devOtp: otp.code,
      message: 'Prototype demo — no real email sent. Use the code below to verify.',
    });
  })
);

// ---------- login (password check, then OTP) ----------
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');

    if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });

    const user = await findUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });

    const matches = await bcrypt.compare(password, user.password_hash);
    if (!matches) return res.status(401).json({ error: 'Invalid email or password.' });

    const otp = await issueOtp(pool, user.id, 'login');
    res.json({
      userId: user.id,
      email: user.email,
      devOtp: otp.code,
      message: 'Prototype demo — no real email sent. Use the code below to verify.',
    });
  })
);

// ---------- resend an OTP for any in-progress scope ----------
router.post(
  '/resend-otp',
  asyncHandler(async (req, res) => {
    const { userId, scope } = req.body;
    if (!['signup', 'login', 'reset', '2fa_setup'].includes(scope)) {
      return res.status(400).json({ error: 'Unknown verification scope.' });
    }
    const user = await findUserById(userId);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    const otp = await issueOtp(pool, userId, scope);
    res.json({ devOtp: otp.code });
  })
);

// ---------- verify signup OTP -> creates verified session ----------
router.post(
  '/verify-signup',
  asyncHandler(async (req, res) => {
    const { userId, code } = req.body;
    const user = await findUserById(userId);
    if (!user) return res.status(404).json({ error: 'Account not found.' });

    const result = await verifyOtp(pool, userId, 'signup', code);
    if (!result.ok) return res.status(400).json({ error: otpErrorMessage(result.reason) });

    await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [userId]);
    await addAudit(userId, user.name, 'Verified email via OTP', user.email, 'success');
    await addAudit(userId, user.name, 'Vault created', 'Welcome to Digital Legacy Manager', 'success');

    const sessionId = await createSession(userId, req);
    const token = signToken({ userId, sessionId });
    const fresh = await findUserById(userId);
    res.json({ token, user: serializeUser(fresh), security: serializeSecurity(fresh) });
  })
);

// ---------- verify login OTP -> creates session ----------
router.post(
  '/verify-login',
  asyncHandler(async (req, res) => {
    const { userId, code } = req.body;
    const user = await findUserById(userId);
    if (!user) return res.status(404).json({ error: 'Account not found.' });

    const result = await verifyOtp(pool, userId, 'login', code);
    if (!result.ok) return res.status(400).json({ error: otpErrorMessage(result.reason) });

    if (!user.email_verified) {
      await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [userId]);
    }
    await addAudit(userId, user.name, 'Verified email via OTP', user.email, 'success');

    const device = describeDevice(req.headers['user-agent']);
    const sessionId = await createSession(userId, req);
    await addAudit(userId, user.name, 'Logged in', `${device} · Prototype session`, 'success');

    const token = signToken({ userId, sessionId });
    const fresh = await findUserById(userId);
    res.json({ token, user: serializeUser(fresh), security: serializeSecurity(fresh) });
  })
);

// ---------- forgot password ----------
router.post(
  '/forgot-password',
  asyncHandler(async (req, res) => {
    const email = String(req.body.email || '').trim();
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });

    const user = await findUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'No account found with that email.' });

    const otp = await issueOtp(pool, user.id, 'reset');
    res.json({ userId: user.id, email: user.email, devOtp: otp.code });
  })
);

router.post(
  '/verify-reset',
  asyncHandler(async (req, res) => {
    const { userId, code } = req.body;
    const user = await findUserById(userId);
    if (!user) return res.status(404).json({ error: 'Account not found.' });

    const result = await verifyOtp(pool, userId, 'reset', code);
    if (!result.ok) return res.status(400).json({ error: otpErrorMessage(result.reason) });

    // Short-lived, single-purpose token so the actual password reset call
    // doesn't need to re-send the OTP code.
    const resetToken = jwt.sign({ purpose: 'password_reset', sub: userId }, RESET_TOKEN_SECRET, {
      expiresIn: '10m',
    });
    res.json({ resetToken });
  })
);

router.post(
  '/reset-password',
  asyncHandler(async (req, res) => {
    const { resetToken, newPassword } = req.body;
    if (String(newPassword || '').length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters.' });
    }
    let payload;
    try {
      payload = jwt.verify(resetToken, RESET_TOKEN_SECRET);
    } catch (err) {
      return res.status(400).json({ error: 'This reset link has expired. Start over from "Forgot password?".' });
    }
    if (payload.purpose !== 'password_reset') {
      return res.status(400).json({ error: 'Invalid reset token.' });
    }
    const user = await findUserById(payload.sub);
    if (!user) return res.status(404).json({ error: 'Account not found.' });

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1, password_changed_at = now() WHERE id = $2', [
      passwordHash,
      user.id,
    ]);
    await addAudit(user.id, user.email, 'Password reset completed', 'Verified via emailed code', 'success');
    res.json({ ok: true });
  })
);

// ---------- authenticated: session bootstrap ----------
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await findUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    res.json({ user: serializeUser(user), security: serializeSecurity(user) });
  })
);

router.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await findUserById(req.userId);
    await pool.query('DELETE FROM sessions WHERE id = $1', [req.sessionId]);
    if (user) await addAudit(user.id, user.name, 'Logged out', user.email, 'info');
    res.json({ ok: true });
  })
);

// ---------- authenticated: change password ----------
router.post(
  '/change-password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const user = await findUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'Account not found.' });

    if (!currentPassword) return res.status(400).json({ error: 'Enter your current password.' });
    const matches = await bcrypt.compare(String(currentPassword), user.password_hash);
    if (!matches) return res.status(400).json({ error: 'Current password is incorrect.' });
    if (String(newPassword || '').length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1, password_changed_at = now() WHERE id = $2', [
      passwordHash,
      user.id,
    ]);
    await addAudit(user.id, user.name, 'Changed password', 'Security setting changed', 'success');
    const fresh = await findUserById(user.id);
    res.json({ security: serializeSecurity(fresh) });
  })
);

// ---------- authenticated: 2FA setup ----------
router.post(
  '/2fa/setup',
  requireAuth,
  asyncHandler(async (req, res) => {
    const otp = await issueOtp(pool, req.userId, '2fa_setup');
    res.json({ devOtp: otp.code });
  })
);

router.post(
  '/2fa/confirm',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { code } = req.body;
    const user = await findUserById(req.userId);
    const result = await verifyOtp(pool, req.userId, '2fa_setup', code);
    if (!result.ok) return res.status(400).json({ error: otpErrorMessage(result.reason) });

    await pool.query('UPDATE users SET two_fa_enabled = true WHERE id = $1', [req.userId]);
    await addAudit(req.userId, user.name, 'Enabled two-factor authentication', 'Authenticator app linked', 'success');
    const fresh = await findUserById(req.userId);
    res.json({ security: serializeSecurity(fresh) });
  })
);

router.post(
  '/2fa/disable',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await findUserById(req.userId);
    await pool.query('UPDATE users SET two_fa_enabled = false WHERE id = $1', [req.userId]);
    await addAudit(req.userId, user.name, 'Disabled two-factor authentication', 'Security setting changed', 'warning');
    const fresh = await findUserById(req.userId);
    res.json({ security: serializeSecurity(fresh) });
  })
);

function otpErrorMessage(reason) {
  switch (reason) {
    case 'expired':
      return 'That code has expired. Request a new one.';
    case 'too_many_attempts':
      return 'Too many incorrect attempts. Request a new code.';
    case 'not_found':
      return 'No code is pending — request a new one.';
    default:
      return 'That code doesn’t match. Check the demo code and try again.';
  }
}

module.exports = router;
