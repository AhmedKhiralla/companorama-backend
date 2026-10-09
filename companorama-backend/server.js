const fastify = require('fastify')({ logger: true });
const { Pool } = require('pg');
const nodemailer = require('nodemailer');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Mailer Setup (e.g., SendGrid, Resend, or SMTP)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

// Helper for Part 11 Audit Trail Logging
async function writeAuditLog(client, tenantId, userId, username, action, entity, oldVal, newVal, reason, ip) {
  const query = `
    INSERT INTO audit_trail (tenant_id, user_id, username, action, entity_affected, old_value, new_value, reason, ip_address)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `;
  await client.query(query, [tenantId, userId, username, action, entity, oldVal, newVal, reason, ip]);
}

// 1. Helicopter View Aggregations Endpoint
fastify.get('/api/v1/helicopter', async (req, reply) => {
  const { tenant_code, date_key } = req.query;

  const res = await pool.query(`
    SELECT 
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
    GROUP BY f.factory_name, a.area_name, m.machine_code, m.machine_name
  `, [tenant_code, date_key]);

  return { group: tenant_code, machines: res.rows };
});

// 2. Alert Rule Creation with Part 11 Audit Log
fastify.post('/api/v1/alerts', async (req, reply) => {
  const { tenant_id, user_id, username, machine_code, parameter_type, threshold_value, duration_minutes, target_email, reason } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const insertRes = await client.query(`
      INSERT INTO alert_rules (tenant_id, machine_code, parameter_type, threshold_value, duration_minutes, target_email, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
    `, [tenant_id, machine_code, parameter_type, threshold_value, duration_minutes, target_email, username]);

    const newRuleId = insertRes.rows[0].id;

    // Part 11 Audit Logging
    await writeAuditLog(
      client, tenant_id, user_id, username,
      'CREATE_ALERT_RULE', `Rule #${newRuleId} for ${machine_code}`,
      null, { parameter_type, threshold_value, duration_minutes, target_email },
      reason || 'Initial Alert Configuration', req.ip
    );

    await client.query('COMMIT');
    return { success: true, rule_id: newRuleId };
  } catch (err) {
    await client.query('ROLLBACK');
    reply.status(500).send({ error: err.message });
  } finally {
    client.release();
  }
});

// 3. Background Alert Engine (Evaluates Stoppages & Custom Parameters)
setInterval(async () => {
  try {
    const rules = await pool.query(`SELECT * FROM alert_rules WHERE is_active = TRUE`);

    for (const rule of rules.rows) {
      if (rule.parameter_type === 'STATUS_OFF_DURATION') {
        const lastState = await pool.query(`
          SELECT status_val, timestamp FROM telemetry_status 
          WHERE machine_code = $1 ORDER BY timestamp DESC LIMIT 1
        `, [rule.machine_code]);

        if (lastState.rows.length > 0) {
          const { status_val, timestamp } = lastState.rows[0];
          const diffMinutes = (new Date() - new Date(timestamp)) / 60000;

          if (status_val === 'Machine Off' && diffMinutes >= rule.duration_minutes) {
            // Check cooldown to avoid spamming
            const lastTrig = rule.last_triggered_at ? (new Date() - new Date(rule.last_triggered_at)) / 60000 : 9999;
            if (lastTrig > rule.duration_minutes * 2) {
              // Send Email
              await transporter.sendMail({
                from: '"Companorama Alerts" <alerts@companorama.com>',
                to: rule.target_email,
                subject: `🚨 ALARM: ${rule.machine_code} Stopped for > ${Math.round(diffMinutes)} mins`,
                text: `Machine ${rule.machine_code} has been stopped since ${timestamp}. Threshold: ${rule.duration_minutes} mins.`
              });

              await pool.query(`UPDATE alert_rules SET last_triggered_at = NOW() WHERE id = $1`, [rule.id]);
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('Alert Engine Error:', e);
  }
}, 60000); // Evaluates rules every 60 seconds

fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' });