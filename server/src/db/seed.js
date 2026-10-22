// Seeds (or re-seeds) the demo account so "use the demo vault" on the login
// screen has real data to log into. Safe to re-run — it wipes and recreates
// just the demo user's own rows first.
const bcrypt = require('bcryptjs');
const { pool } = require('./pool');

const DEMO_EMAIL = 'demo@vault.app';
const DEMO_PASSWORD = 'demo1234';
const DEMO_NAME = 'Ananya Rao';

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000);
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT id FROM users WHERE lower(email) = lower($1)', [DEMO_EMAIL]);
    if (existing.rows[0]) {
      console.log('Removing existing demo account to reseed fresh data...');
      await client.query('DELETE FROM users WHERE id = $1', [existing.rows[0].id]); // cascades everywhere
    }

    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
    const userRes = await client.query(
      `INSERT INTO users (name, email, password_hash, email_verified, is_demo, two_fa_enabled, inactivity_days, password_changed_at)
       VALUES ($1, $2, $3, true, true, true, 90, $4) RETURNING id`,
      [DEMO_NAME, DEMO_EMAIL, passwordHash, daysAgo(35)]
    );
    const userId = userRes.rows[0].id;

    // Two illustrative past sessions (one "current", matching the old
    // localStorage seed's shape — the real "current" one gets created
    // for real the next time someone actually logs in).
    await client.query(
      `INSERT INTO sessions (user_id, device, ip, created_at) VALUES
       ($1, 'Safari · iPhone 15', 'Hyderabad, IN', $2)`,
      [userId, daysAgo(2)]
    );

    const benef = {};
    for (const b of [
      { key: 'ravi', name: 'Ravi Kapoor', relationship: 'Spouse', contact: 'ravi.kapoor@gmail.com', trust: 'Primary', verified: true },
      { key: 'sanjana', name: 'Sanjana Rao', relationship: 'Sister', contact: 'sanjana.rao@gmail.com', trust: 'Primary', verified: true },
      { key: 'arjun', name: 'Arjun Mehta', relationship: 'Executor (family friend)', contact: 'arjun.mehta@mehtalegal.in', trust: 'Secondary', verified: false },
    ]) {
      const { rows } = await client.query(
        `INSERT INTO beneficiaries (user_id, name, relationship, contact, trust, verified)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [userId, b.name, b.relationship, b.contact, b.trust, b.verified]
      );
      benef[b.key] = rows[0].id;
    }

    const assets = [
      ['Instagram & X (Twitter)', 'social', '@ananya.codes', benef.sanjana, 'Transfer to beneficiary', 'Active', 210],
      ['Personal Gmail', 'email', 'ananya.rao@gmail.com', benef.ravi, 'Transfer to beneficiary', 'Active', 198],
      ['Google Drive backups', 'cloud', '250 GB · family archive', benef.ravi, 'Transfer to beneficiary', 'Active', 190],
      ['HDFC Savings & Fixed Deposits', 'financial', 'A/C ••••4482', benef.ravi, 'Notify only', 'Active', 150],
      ['iCloud Photos', 'cloud', 'Family photo archive', benef.sanjana, 'Transfer to beneficiary', 'Active', 120],
      ['Property & Insurance Documents', 'documents', 'Scanned PDFs, 14 files', benef.arjun, 'Notify only', 'Active', 80],
      ['Bitcoin & Ethereum Wallet', 'crypto', 'Hardware wallet backup', benef.ravi, 'Transfer to beneficiary', 'Pending Review', 20],
      ['Freelance PayPal Account', 'financial', 'Linked to HDFC ••4482', benef.ravi, 'Transfer to beneficiary', 'Active', 9],
    ];
    for (const [name, category, identifier, beneficiaryId, action, status, age] of assets) {
      await client.query(
        `INSERT INTO assets (user_id, name, category, identifier, beneficiary_id, action, status, added_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [userId, name, category, identifier, beneficiaryId, action, status, daysAgo(age)]
      );
    }

    const instructions = [
      ['Transfer social accounts to Sanjana', 'Verified death certificate', benef.sanjana,
        'Hand over Instagram and X account credentials after identity verification.', 'Active'],
      ['Release financial details to Ravi', 'Inactivity period', benef.ravi,
        'After 90 days of inactivity, notify Ravi with a summary of accounts — do not transfer credentials automatically.', 'Active'],
      ['Executor unlocks property documents', 'Manual release by executor', benef.arjun,
        'Arjun may release scanned property and insurance documents once verification is complete.', 'Draft'],
    ];
    for (const [title, trigger, beneficiaryId, details, status] of instructions) {
      await client.query(
        `INSERT INTO instructions (user_id, title, trigger_condition, beneficiary_id, details, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, title, trigger, beneficiaryId, details, status]
      );
    }

    const messages = [
      ['For Ravi, whenever you need this', benef.ravi, 'Verified death certificate',
        'A note about our accounts, the SIPs, and where to find everything. I love you.', 140],
      ['Instagram memories — a note for Sanjana', benef.sanjana, 'Inactivity period',
        'If you ever get access to this account, keep the travel album — that trip meant a lot.', 60],
    ];
    for (const [subject, to, condition, body, age] of messages) {
      await client.query(
        `INSERT INTO messages (user_id, subject, to_beneficiary_id, condition, body, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'Locked', $6)`,
        [userId, subject, to, condition, body, daysAgo(age)]
      );
    }

    const auditRows = [
      ['Ananya Rao', 'Logged in', 'Chrome · Windows · Hyderabad, IN', 'success', 0, 7],
      ['Ananya Rao', 'Added asset', 'Freelance PayPal Account', 'info', 9, 0],
      ['Ananya Rao', 'Added asset', 'Bitcoin & Ethereum Wallet — pending review', 'warning', 20, 0],
      ['System', 'Verification pending', 'Beneficiary Arjun Mehta has not confirmed contact details', 'warning', 21, 0],
      ['Ananya Rao', 'Enabled two-factor authentication', 'Authenticator app linked', 'success', 35, 0],
      ['System', 'Blocked sign-in attempt', 'Unrecognized device · IP flagged and denied', 'critical', 58, 0],
      ['Ananya Rao', 'Updated inactivity trigger', 'Set to 90 days', 'info', 75, 0],
      ['Ananya Rao', 'Scheduled legacy message', 'Instagram memories — a note for Sanjana', 'info', 120, 0],
    ];
    for (const [actor, action, detail, status, ageDays, extraMinutes] of auditRows) {
      const ts = new Date(daysAgo(ageDays).getTime() - extraMinutes * 60000);
      await client.query(
        `INSERT INTO audit_log (user_id, actor, action, detail, status, ts) VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, actor, action, detail, status, ts]
      );
    }

    await client.query('COMMIT');
    console.log('Demo account seeded:');
    console.log(`  email:    ${DEMO_EMAIL}`);
    console.log(`  password: ${DEMO_PASSWORD}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
