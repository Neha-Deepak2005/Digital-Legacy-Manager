const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  // A background/idle client threw an error — log it instead of crashing
  // the whole server over one bad connection.
  console.error('Unexpected Postgres pool error', err);
});

module.exports = { pool };
