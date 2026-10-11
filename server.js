const fastify = require('fastify')({ logger: true });

// Enable CORS to allow requests from Netlify and local testing
fastify.register(require('@fastify/cors'), {
  origin: true, // Allows all origins (safest for multi-tenant web apps and local files)
  methods: ['GET', 'POST', 'PUT', 'DELETE']
});

const { Pool } = require('pg');
const nodemailer = require('nodemailer');

// ============================================================
// 1. DATABASE & MAILER CONFIGURATION
// ============================================================

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// Initialize PostgreSQL Connection Pool using Railway's environment variable
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost') 
    ? { rejectUnauthorized: false } 
    : false
});

// Configure Nodemailer Transporter for Email Alerts
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  }
});

// ============================================================
// 2. 21 CFR PART 11 AUDIT TRAIL HELPER
// ============================================================

async function writeAuditLog(client, tenantId, userId, username, action, entity, oldVal, newVal, reason, ip) {
  const query = `
    INSERT INTO audit_trail (tenant_id, user_id, username, action, entity_affected, old_value, new_value, reason, ip_address)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `;
  await client.query(query, [
    tenantId || null,
    userId || null,
    username || 'SYSTEM',
    action,
    entity,
    oldVal ? JSON.stringify(oldVal) : null,
    newVal ? JSON.stringify(newVal) : null,
    reason || 'N/A',
    ip || '127.0.0.1'
  ]);
}

// ============================================================
// 3. API ENDPOINTS
// ============================================================

// Health Check Endpoint (Required for Railway Deployments)
fastify.get('/health', async (request, reply) => {
  try {
    await pool.query('SELECT 1');
    return { status: 'ok', database: 'connected', timestamp: new Date().toISOString() };
  } catch (err) {
    reply.status(500).send({ status: 'error', database: 'disconnected', message: err.message });
  }
});

// Root Endpoint
fastify.get('/', async (request, reply) => {
  return { system: 'Companorama Telemetry & Audit API', status: 'operational', version: '1.0.0' };
});

// ------------------------------------------------------------
// TELEMETRY INGESTION (From ESP32 Firmware)
// ------------------------------------------------------------

fastify.post('/api/v1/telemetry', async (request, reply) => {
  const { machine_code, category, type, val, timestamp, dateKey } = request.body;

  if (!machine_code || !category) {
    return reply.status(400).send({ error: 'Missing required telemetry fields.' });
  }

  const logTimestamp = timestamp || new Date().toISOString();
  const logDateKey = dateKey || logTimestamp.split('T')[0];

  try {
    if (category === 'status_logs') {
      await pool.query(`
        INSERT INTO telemetry_status (machine_code, status_val, timestamp, date_key)
        VALUES ($1, $2, $3, $4)
      `, [machine_code, val || 'UNKNOWN', logTimestamp, logDateKey]);
    } else {
      await pool.query(`
        INSERT INTO telemetry_events (machine_code, event_type, timestamp, date_key)
        VALUES ($1, $2, $3, $4)
      `, [machine_code, type || 'cycles count', logTimestamp, logDateKey]);
    }

    return { success: true };
  } catch (err) {
    fastify.log.error(err);
    return reply.status(500).send({ error: 'Failed to insert telemetry into PostgreSQL.' });
  }
});

// ------------------------------------------------------------
// TELEMETRY QUERY (For Netlify Front-End Dashboard)
// ------------------------------------------------------------

fastify.get('/api/v1/telemetry', async (request, reply) => {
  const { machine_code, date_key } = request.query;

  if (!machine_code || !date_key) {
    return reply.status(400).send({ error: 'Parameters machine_code and date_key are required.' });
  }

  try {
    const eventsRes = await pool.query(`
      SELECT id, machine_code, event_type as type, timestamp, date_key 
      FROM telemetry_events 
      WHERE machine_code = $1 AND date_key = $2 
      ORDER BY timestamp ASC
    `, [machine_code, date_key]);

    const statusRes = await pool.query(`
      SELECT id, machine_code, status_val as val, timestamp, date_key 
      FROM telemetry_status 
      WHERE machine_code = $1 AND date_key = $2 
      ORDER BY timestamp ASC
    `, [machine_code, date_key]);

    return {
      events: eventsRes.rows,
      status_logs: statusRes.rows
    };
  } catch (err) {
    fastify.log.error(err);
    return reply.status(500).send({ error: 'Failed to fetch telemetry data.' });
  }
});

// ------------------------------------------------------------
// HELICOPTER VIEW AGGREGATIONS
// ------------------------------------------------------------

fastify.get('/api/v1/helicopter', async (request, reply) => {
  const { tenant_code, date_key } = request.query;
  const targetDate = date_key || new Date().toISOString().split('T')[0];

  try {
    const query = `
      SELECT 
        t.group_code,
        f.factory_name,
        a.area_name,
        m.machine_code,
        m.machine_name,
        COUNT(e.id) FILTER (WHERE e.event_type = 'cycles count') as total_cycles,
        COUNT(e.id) FILTER (WHERE e.event_type = 'rejected products cycle count') as rejected_cycles
      FROM tenants t
      JOIN factories f ON f.tenant_id = t.id
      JOIN areas a ON a.factory_id = f.id
      JOIN machines m ON m.area_id = a.id
      LEFT JOIN telemetry_events e ON e.machine_code = m.machine_code AND e.date_key = $2
      WHERE t.group_code = $1
      GROUP BY t.group_code, f.factory_name, a.area_name, m.machine_code, m.machine_name
    `;

    const res = await pool.query(query, [tenant_code || 'Comp11_Labs', targetDate]);
    return { group: tenant_code || 'Comp11_Labs', date_key: targetDate, machines: res.rows };
  } catch (err) {
    fastify.log.error(err);
    return reply.status(500).send({ error: 'Failed to fetch helicopter aggregate view.' });
  }
});

// ------------------------------------------------------------
// ALERTS CONFIGURATION & PART 11 AUDITING
// ------------------------------------------------------------

fastify.get('/api/v1/alerts', async (request, reply) => {
  try {
    const res = await pool.query(`SELECT * FROM alert_rules ORDER BY id DESC`);
    return { alerts: res.rows };
  } catch (err) {
    return reply.status(500).send({ error: err.message });
  }
});

fastify.post('/api/v1/alerts', async (request, reply) => {
  const { tenant_id, user_id, username, machine_code, parameter_type, threshold_value, duration_minutes, target_email, reason } = request.body;

  if (!reason || reason.trim().length === 0) {
    return reply.status(400).send({ error: '21 CFR Part 11 Compliance Error: A valid "reason" for change is required.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const insertRes = await client.query(`
      INSERT INTO alert_rules (tenant_id, machine_code, parameter_type, threshold_value, duration_minutes, target_email, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
    `, [tenant_id || 1, machine_code, parameter_type, threshold_value, duration_minutes, target_email, username || 'Anonymous']);

    const newRuleId = insertRes.rows[0].id;

    // Log to Immutable 21 CFR Part 11 Audit Trail
    await writeAuditLog(
      client, 
      tenant_id || 1, 
      user_id || 1, 
      username || 'Operator',
      'CREATE_ALERT_RULE', 
      `Rule #${newRuleId} for Machine ${machine_code}`,
      null, 
      { parameter_type, threshold_value, duration_minutes, target_email },
      reason, 
      request.ip
    );

    await client.query('COMMIT');
    return { success: true, rule_id: newRuleId };
  } catch (err) {
    await client.query('ROLLBACK');
    fastify.log.error(err);
    return reply.status(500).send({ error: err.message });
  } finally {
    client.release();
  }
});

// ------------------------------------------------------------
// AUDIT TRAIL LOG VIEWER
// ------------------------------------------------------------

fastify.get('/api/v1/audit-trail', async (request, reply) => {
  try {
    const res = await pool.query(`SELECT * FROM audit_trail ORDER BY timestamp DESC LIMIT 100`);
    return { audit_logs: res.rows };
  } catch (err) {
    return reply.status(500).send({ error: err.message });
  }
});

// ============================================================
// 4. BACKGROUND AUTOMATED ALERT EVALUATION ENGINE
// ============================================================

setInterval(async () => {
  try {
    const rulesRes = await pool.query(`SELECT * FROM alert_rules WHERE is_active = TRUE`);

    for (const rule of rulesRes.rows) {
      if (rule.parameter_type === 'STATUS_OFF_DURATION') {
        const lastStateRes = await pool.query(`
          SELECT status_val, timestamp FROM telemetry_status 
          WHERE machine_code = $1 ORDER BY timestamp DESC LIMIT 1
        `, [rule.machine_code]);

        if (lastStateRes.rows.length > 0) {
          const { status_val, timestamp } = lastStateRes.rows[0];
          const diffMinutes = (new Date() - new Date(timestamp)) / (1000 * 60);

          if (status_val === 'Machine Off' && diffMinutes >= rule.duration_minutes) {
            const lastTrigDiff = rule.last_triggered_at 
              ? (new Date() - new Date(rule.last_triggered_at)) / (1000 * 60) 
              : 9999;

            // Cooldown check to prevent duplicate emails
            if (lastTrigDiff > rule.duration_minutes * 2) {
              if (process.env.SMTP_USER) {
                await transporter.sendMail({
                  from: '"Companorama Alerts" <alerts@companorama.com>',
                  to: rule.target_email,
                  subject: `🚨 ALARM: Machine ${rule.machine_code} Stopped for > ${Math.round(diffMinutes)} mins`,
                  html: `
                    <h3>Companorama Machine Downtime Alert</h3>
                    <p><strong>Machine:</strong> ${rule.machine_code}</p>
                    <p><strong>Status:</strong> Machine Off</p>
                    <p><strong>Stopped Since:</strong> ${timestamp}</p>
                    <p><strong>Duration:</strong> ${Math.round(diffMinutes)} minutes (Threshold: ${rule.duration_minutes} mins)</p>
                    <hr>
                    <p><small>Automated alert generated by Companorama Enterprise System.</small></p>
                  `
                });
              } else {
                fastify.log.warn(`Alert triggered for ${rule.machine_code}, but SMTP_USER is not configured.`);
              }

              await pool.query(`UPDATE alert_rules SET last_triggered_at = NOW() WHERE id = $1`, [rule.id]);
            }
          }
        }
      }
    }
  } catch (err) {
    fastify.log.error(`Alert Engine Error: ${err.message}`);
  }
}, 60000); // Runs once every 60 seconds

// ============================================================
// 5. SERVER INITIALIZATION & LISTENER
// ============================================================

const start = async () => {
  try {
    await fastify.listen({ port: Number(PORT), host: HOST });
    console.log(`🚀 Companorama Production Server listening on http://${HOST}:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
