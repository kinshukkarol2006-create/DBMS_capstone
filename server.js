require('dotenv').config();

const express = require('express');
const path = require('node:path');
const mysql = require('mysql2/promise');

const app = express();
const port = Number(process.env.PORT) || 3000;
const workspaceId = Number(process.env.WORKSPACE_ID) || 1;
const pageSize = 10;
const statusLabels = {
  pending: 'Pending',
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
const allowedRanges = { '7D': 7, '30D': 30, '90D': 90, '1Y': 365 };

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'recollect',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 5000,
  dateStrings: true,
});

app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));

app.get('/', (_request, response) => response.sendFile(path.join(__dirname, 'index.html')));
app.get('/styles.css', (_request, response) => response.sendFile(path.join(__dirname, 'styles.css')));
app.get('/app.js', (_request, response) => response.sendFile(path.join(__dirname, 'app.js')));

function respondWithDatabaseError(response, error, context) {
  console.error(`${context}:`, error);
  const unavailable = ['ECONNREFUSED', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST'].includes(error.code);
  const missingDatabase = error.code === 'ER_BAD_DB_ERROR';
  const missingSchema = error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_VIEW_INVALID';
  const badCredentials = error.code === 'ER_ACCESS_DENIED_ERROR' || error.code === 'ER_DBACCESS_DENIED_ERROR';
  response.status(unavailable || missingDatabase || badCredentials ? 503 : 500).json({
    error: unavailable
      ? 'MySQL is unavailable. Start MySQL and check DB_HOST, DB_PORT, DB_USER, and DB_PASSWORD in .env.'
      : badCredentials
        ? 'MySQL rejected these credentials. Check DB_USER and DB_PASSWORD in .env, and make sure this user can access DB_NAME.'
      : missingDatabase
        ? 'MySQL database not found. Create the database named in DB_NAME, then run database.sql.'
        : missingSchema
          ? 'MySQL tables or views are missing. Select the database in MySQL Workbench and run database.sql.'
          : 'The database request could not be completed.',
  });
}

function queryFailed(response, error, context) {
  respondWithDatabaseError(response, error, context);
}

function sqlFilter() {
  return `workspace_id = ?
    AND (? = '' OR status = ?)
    AND (? = '' OR request_code LIKE CONCAT('%', ?, '%')
      OR location_name LIKE CONCAT('%', ?, '%')
      OR district_name LIKE CONCAT('%', ?, '%')
      OR device_types LIKE CONCAT('%', ?, '%'))`;
}

function filterParams(status, query) {
  return [workspaceId, status, status, query, query, query, query, query];
}

app.get('/api/health', async (_request, response) => {
  try {
    await pool.query('SELECT 1');
    response.json({ status: 'ok', database: 'connected', engine: 'mysql' });
  } catch (error) {
    queryFailed(response, error, 'MySQL health check failed');
  }
});

app.get('/api/options', async (_request, response) => {
  try {
    const [districts] = await pool.execute(
      `SELECT id, name FROM districts
       WHERE workspace_id = ? AND is_active = TRUE
       ORDER BY name`,
      [workspaceId],
    );
    const [categories] = await pool.execute(
      `SELECT id, name FROM device_categories
       WHERE workspace_id = ? AND is_active = TRUE
       ORDER BY name`,
      [workspaceId],
    );
    response.json({ districts, categories });
  } catch (error) {
    queryFailed(response, error, 'Loading pickup options failed');
  }
});

app.get('/api/dashboard', async (_request, response) => {
  try {
    const [metricRows] = await pool.execute(
      'SELECT * FROM dashboard_monthly_metrics WHERE workspace_id = ?',
      [workspaceId],
    );
    const [goals] = await pool.execute(
      `SELECT recycling_goal_kg
       FROM impact_goals
       WHERE workspace_id = ? AND CURRENT_DATE BETWEEN period_start AND period_end
       ORDER BY created_at DESC
       LIMIT 1`,
      [workspaceId],
    );
    const [categories] = await pool.execute(
      `SELECT dc.id, dc.name, COALESCE(t.item_count, 0) AS item_count
       FROM device_categories AS dc
       LEFT JOIN monthly_device_category_totals AS t
         ON t.device_category_id = dc.id AND t.workspace_id = dc.workspace_id
       WHERE dc.workspace_id = ? AND dc.is_active = TRUE
       ORDER BY item_count DESC, dc.name`,
      [workspaceId],
    );

    response.json({
      metrics: {
        ...(metricRows[0] || {
          pickups_requested_this_month: 0,
          awaiting_collection: 0,
          needing_attention: 0,
          active_partners: 0,
          recycled_weight_kg_this_month: 0,
        }),
        recycling_goal_kg: goals[0]?.recycling_goal_kg ?? 0,
      },
      categories,
    });
  } catch (error) {
    queryFailed(response, error, 'Loading dashboard metrics failed');
  }
});

app.get('/api/volume', async (request, response) => {
  const range = String(request.query.range || '30D').toUpperCase();
  const days = allowedRanges[range];
  if (!days) {
    return response.status(400).json({ error: 'Range must be 7D, 30D, 90D, or 1Y.' });
  }

  try {
    const [rows] = await pool.execute(
      `SELECT DATE_FORMAT(activity_date, '%Y-%m-%d') AS activity_date,
              collected_items, collected_weight_kg, recycled_weight_kg
       FROM daily_collection_volume
       WHERE workspace_id = ?
         AND activity_date >= CURRENT_DATE - INTERVAL ? DAY
         AND activity_date <= CURRENT_DATE
       ORDER BY activity_date`,
      [workspaceId, days - 1],
    );
    const byDate = new Map(rows.map((row) => [row.activity_date, row]));
    const today = new Date();
    const points = Array.from({ length: days }, (_, index) => {
      const date = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() - days + 1 + index));
      const activityDate = date.toISOString().slice(0, 10);
      return byDate.get(activityDate) || {
        activity_date: activityDate,
        collected_items: 0,
        collected_weight_kg: 0,
        recycled_weight_kg: 0,
      };
    });
    response.json({ range, points });
  } catch (error) {
    queryFailed(response, error, 'Loading collection volume failed');
  }
});

app.get('/api/routes', async (_request, response) => {
  try {
    const [routes] = await pool.execute(
      `SELECT cr.id, cr.route_name,
              DATE_FORMAT(cr.route_date, '%Y-%m-%d') AS route_date,
              cr.status, COALESCE(u.full_name, 'Unassigned') AS driver_name,
              COUNT(rs.id) AS stop_count
       FROM collection_routes AS cr
       LEFT JOIN users AS u ON u.id = cr.assigned_driver_id
       LEFT JOIN route_stops AS rs ON rs.route_id = cr.id
       WHERE cr.workspace_id = ?
       GROUP BY cr.id, cr.route_name, cr.route_date, cr.status, u.full_name
       ORDER BY cr.route_date DESC, cr.id DESC`,
      [workspaceId],
    );
    response.json({ routes });
  } catch (error) {
    queryFailed(response, error, 'Loading collection routes failed');
  }
});

app.get('/api/recycling', async (_request, response) => {
  try {
    const [batches] = await pool.execute(
      `SELECT rb.id, rb.batch_code, rb.status,
              DATE_FORMAT(rb.received_at, '%Y-%m-%d') AS received_at,
              DATE_FORMAT(rb.completed_at, '%Y-%m-%d') AS completed_at,
              partner.name AS partner_name,
              COALESCE(SUM(rbi.recycled_weight_kg), 0) AS recycled_weight_kg,
              COALESCE(GROUP_CONCAT(DISTINCT dc.name ORDER BY dc.name SEPARATOR ', '), '') AS categories
       FROM recycling_batches AS rb
       JOIN organizations AS partner ON partner.id = rb.recycling_partner_id
       LEFT JOIN recycling_batch_items AS rbi ON rbi.batch_id = rb.id
       LEFT JOIN device_categories AS dc ON dc.id = rbi.device_category_id
       WHERE rb.workspace_id = ?
       GROUP BY rb.id, rb.batch_code, rb.status, rb.received_at,
                rb.completed_at, partner.name
       ORDER BY rb.received_at DESC, rb.id DESC`,
      [workspaceId],
    );
    response.json({ batches });
  } catch (error) {
    queryFailed(response, error, 'Loading recycling batches failed');
  }
});

app.get('/api/partners', async (_request, response) => {
  try {
    const [partners] = await pool.execute(
      `SELECT id, name, organization_type, contact_email, phone, is_active
       FROM organizations
       WHERE workspace_id = ?
         AND organization_type IN ('collection_partner', 'recycling_partner')
       ORDER BY is_active DESC, name`,
      [workspaceId],
    );
    response.json({ partners });
  } catch (error) {
    queryFailed(response, error, 'Loading workspace partners failed');
  }
});

app.get('/api/pickups/export', async (request, response) => {
  const query = String(request.query.q || '').trim().slice(0, 100);
  const status = String(request.query.status || '').toLowerCase();
  if (status !== '' && !Object.hasOwn(statusLabels, status)) {
    return response.status(400).json({ error: 'Unknown pickup status.' });
  }

  try {
    const params = filterParams(status, query);
    const [[countRows], [pickups]] = await Promise.all([
      pool.execute(
        `SELECT COUNT(*) AS total FROM pickup_request_dashboard WHERE ${sqlFilter()}`,
        params,
      ),
      pool.execute(
        `SELECT request_code, location_name, district_name, status,
                scheduled_for, device_types, estimated_weight_kg
         FROM pickup_request_dashboard
         WHERE ${sqlFilter()}
         ORDER BY requested_at DESC, request_code DESC
         LIMIT 5000`,
        params,
      ),
    ]);
    const totalCount = Number(countRows[0].total);
    response.json({ pickups, totalCount, truncated: totalCount > pickups.length });
  } catch (error) {
    queryFailed(response, error, 'Exporting pickups failed');
  }
});

app.get('/api/pickups', async (request, response) => {
  const page = Math.max(1, Number.parseInt(request.query.page, 10) || 1);
  const query = String(request.query.q || '').trim().slice(0, 100);
  const status = String(request.query.status || '').toLowerCase();
  if (status !== '' && !Object.hasOwn(statusLabels, status)) {
    return response.status(400).json({ error: 'Unknown pickup status.' });
  }

  try {
    const params = filterParams(status, query);
    const [[countRows], [pickups]] = await Promise.all([
      pool.execute(
        `SELECT COUNT(*) AS total FROM pickup_request_dashboard WHERE ${sqlFilter()}`,
        params,
      ),
      pool.execute(
        `SELECT id, request_code, location_name, district_name, status,
                scheduled_for, device_types, estimated_weight_kg, requested_at
         FROM pickup_request_dashboard
         WHERE ${sqlFilter()}
         ORDER BY requested_at DESC, request_code DESC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, (page - 1) * pageSize],
      ),
    ]);

    const totalCount = Number(countRows[0].total);
    response.json({
      pickups,
      page,
      pageSize,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
    });
  } catch (error) {
    queryFailed(response, error, 'Loading pickups failed');
  }
});

app.post('/api/pickups', async (request, response) => {
  const { location, districtId, deviceCategoryId, weight, scheduledFor } = request.body || {};
  const trimmedLocation = typeof location === 'string' ? location.trim() : '';
  const numericDistrictId = Number(districtId);
  const numericCategoryId = Number(deviceCategoryId);
  const numericWeight = Number(weight);
  const validDate = typeof scheduledFor === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(scheduledFor)
    && !Number.isNaN(Date.parse(`${scheduledFor}T00:00:00Z`))
    && new Date(`${scheduledFor}T00:00:00Z`).toISOString().slice(0, 10) === scheduledFor;

  if (
    trimmedLocation.length < 2
    || trimmedLocation.length > 120
    || !Number.isSafeInteger(numericDistrictId)
    || numericDistrictId <= 0
    || !Number.isSafeInteger(numericCategoryId)
    || numericCategoryId <= 0
    || !Number.isFinite(numericWeight)
    || numericWeight <= 0
    || numericWeight > 100000
    || !validDate
  ) {
    return response.status(400).json({ error: 'Enter a valid location, district, device type, weight, and date.' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [[districtRows], [categoryRows]] = await Promise.all([
      connection.execute(
        `SELECT id FROM districts
         WHERE id = ? AND workspace_id = ? AND is_active = TRUE`,
        [numericDistrictId, workspaceId],
      ),
      connection.execute(
        `SELECT id FROM device_categories
         WHERE id = ? AND workspace_id = ? AND is_active = TRUE`,
        [numericCategoryId, workspaceId],
      ),
    ]);
    if (!districtRows.length || !categoryRows.length) {
      await connection.rollback();
      return response.status(400).json({ error: 'Select an active district and device category.' });
    }

    const [inserted] = await connection.execute(
      `INSERT INTO pickup_requests (
         workspace_id, request_code, requester_name, location_name,
         district_id, status, scheduled_for
       )
       VALUES (?, '', ?, ?, ?, 'pending', ?)`,
      [workspaceId, trimmedLocation, trimmedLocation, numericDistrictId, scheduledFor],
    );
    const requestCode = `EW-${inserted.insertId}`;
    await connection.execute(
      'UPDATE pickup_requests SET request_code = ? WHERE id = ?',
      [requestCode, inserted.insertId],
    );
    await connection.execute(
      `INSERT INTO pickup_request_items (
         pickup_request_id, device_category_id, quantity, estimated_weight_kg
       )
       VALUES (?, ?, 1, ?)`,
      [inserted.insertId, numericCategoryId, numericWeight],
    );
    await connection.commit();

    const [pickups] = await pool.execute(
      `SELECT id, request_code, location_name, district_name, status,
              scheduled_for, device_types, estimated_weight_kg, requested_at
       FROM pickup_request_dashboard
       WHERE id = ? AND workspace_id = ?`,
      [inserted.insertId, workspaceId],
    );
    response.status(201).json({ pickup: pickups[0] });
  } catch (error) {
    if (connection) {
      await connection.rollback().catch((rollbackError) => {
        console.error('Rolling back pickup creation failed:', rollbackError);
      });
    }
    queryFailed(response, error, 'Creating pickup failed');
  } finally {
    connection?.release();
  }
});

app.get('/api/pickups/:id', async (request, response) => {
  const pickupId = Number(request.params.id);
  if (!Number.isSafeInteger(pickupId) || pickupId <= 0) {
    return response.status(400).json({ error: 'Invalid pickup ID.' });
  }

  try {
    const [rows] = await pool.execute(
      `SELECT p.id, p.request_code, p.requester_name, p.requester_email, p.requester_phone,
              p.location_name, p.street_address, p.district_id, d.name AS district_name,
              p.status, p.requested_at, DATE_FORMAT(p.scheduled_for, '%Y-%m-%d') AS scheduled_for, p.notes,
              COALESCE(SUM(i.estimated_weight_kg), 0) AS estimated_weight_kg,
              COALESCE(GROUP_CONCAT(DISTINCT dc.name ORDER BY dc.name SEPARATOR ', '), 'Unspecified') AS device_types,
              MAX(i.device_category_id) AS device_category_id
       FROM pickup_requests AS p
       JOIN districts AS d ON d.id = p.district_id
       LEFT JOIN pickup_request_items AS i ON i.pickup_request_id = p.id
       LEFT JOIN device_categories AS dc ON dc.id = i.device_category_id
       WHERE p.id = ? AND p.workspace_id = ?
       GROUP BY p.id, p.request_code, p.requester_name, p.requester_email, p.requester_phone,
                p.location_name, p.street_address, p.district_id, d.name, p.status,
                p.requested_at, p.scheduled_for, p.notes`,
      [pickupId, workspaceId],
    );

    if (!rows.length) {
      return response.status(404).json({ error: 'Pickup request not found.' });
    }

    response.json({ pickup: rows[0] });
  } catch (error) {
    queryFailed(response, error, 'Loading pickup details failed');
  }
});

app.patch('/api/pickups/:id/status', async (request, response) => {
  const pickupId = Number(request.params.id);
  const status = String(request.body?.status || '').toLowerCase();

  if (!Number.isSafeInteger(pickupId) || pickupId <= 0) {
    return response.status(400).json({ error: 'Invalid pickup ID.' });
  }
  if (!Object.hasOwn(statusLabels, status)) {
    return response.status(400).json({ error: 'Invalid pickup status.' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `SELECT p.id, p.request_code, p.status, p.location_name,
              COALESCE(SUM(i.estimated_weight_kg), 0) AS weight,
              COALESCE(SUM(i.quantity), 1) AS items
       FROM pickup_requests AS p
       LEFT JOIN pickup_request_items AS i ON i.pickup_request_id = p.id
       WHERE p.id = ? AND p.workspace_id = ?
       GROUP BY p.id, p.request_code, p.status, p.location_name`,
      [pickupId, workspaceId],
    );

    if (!rows.length) {
      await connection.rollback();
      return response.status(404).json({ error: 'Pickup request not found.' });
    }

    const pickup = rows[0];
    const oldStatus = pickup.status;

    await connection.execute(
      'UPDATE pickup_requests SET status = ? WHERE id = ? AND workspace_id = ?',
      [status, pickupId, workspaceId],
    );

    if (status === 'completed') {
      await connection.execute(
        `INSERT INTO collections (pickup_request_id, collected_by, collected_at, item_count, collected_weight_kg, notes)
         VALUES (?, 1, CURRENT_TIMESTAMP, ?, ?, 'Collected and verified')
         ON DUPLICATE KEY UPDATE collected_weight_kg = VALUES(collected_weight_kg), item_count = VALUES(item_count)`,
        [pickupId, pickup.items || 1, Number(pickup.weight) || 5.0],
      );
    }

    const readableStatus = statusLabels[status] || status;
    await connection.execute(
      `INSERT INTO notifications (workspace_id, title, message)
       VALUES (?, ?, ?)`,
      [
        workspaceId,
        `Pickup #${pickup.request_code} ${readableStatus}`,
        `${pickup.location_name} status updated from ${statusLabels[oldStatus] || oldStatus} to ${readableStatus}.`,
      ],
    );

    await connection.commit();

    const [updatedRows] = await pool.execute(
      `SELECT id, request_code, location_name, district_name, status,
              scheduled_for, device_types, estimated_weight_kg, requested_at
       FROM pickup_request_dashboard
       WHERE id = ? AND workspace_id = ?`,
      [pickupId, workspaceId],
    );

    response.json({ pickup: updatedRows[0] });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    queryFailed(response, error, 'Updating pickup status failed');
  } finally {
    connection?.release();
  }
});

app.put('/api/pickups/:id', async (request, response) => {
  const pickupId = Number(request.params.id);
  const { location, districtId, deviceCategoryId, weight, scheduledFor, notes } = request.body || {};
  const trimmedLocation = typeof location === 'string' ? location.trim() : '';
  const trimmedNotes = typeof notes === 'string' ? notes.trim() : '';
  const numericDistrictId = Number(districtId);
  const numericCategoryId = Number(deviceCategoryId);
  const numericWeight = Number(weight);
  const validDate = typeof scheduledFor === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(scheduledFor)
    && !Number.isNaN(Date.parse(`${scheduledFor}T00:00:00Z`))
    && new Date(`${scheduledFor}T00:00:00Z`).toISOString().slice(0, 10) === scheduledFor;

  if (
    !Number.isSafeInteger(pickupId)
    || pickupId <= 0
    || trimmedLocation.length < 2
    || trimmedLocation.length > 120
    || !Number.isSafeInteger(numericDistrictId)
    || numericDistrictId <= 0
    || !Number.isSafeInteger(numericCategoryId)
    || numericCategoryId <= 0
    || !Number.isFinite(numericWeight)
    || numericWeight <= 0
    || numericWeight > 100000
    || !validDate
  ) {
    return response.status(400).json({ error: 'Enter a valid location, district, device category, weight, and scheduled date.' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [[pickupRows], [districtRows], [categoryRows]] = await Promise.all([
      connection.execute(
        'SELECT id, request_code FROM pickup_requests WHERE id = ? AND workspace_id = ?',
        [pickupId, workspaceId],
      ),
      connection.execute(
        'SELECT id FROM districts WHERE id = ? AND workspace_id = ? AND is_active = TRUE',
        [numericDistrictId, workspaceId],
      ),
      connection.execute(
        'SELECT id FROM device_categories WHERE id = ? AND workspace_id = ? AND is_active = TRUE',
        [numericCategoryId, workspaceId],
      ),
    ]);

    if (!pickupRows.length) {
      await connection.rollback();
      return response.status(404).json({ error: 'Pickup request not found.' });
    }
    if (!districtRows.length || !categoryRows.length) {
      await connection.rollback();
      return response.status(400).json({ error: 'Select an active district and device category.' });
    }

    const requestCode = pickupRows[0].request_code;

    await connection.execute(
      `UPDATE pickup_requests
       SET location_name = ?, district_id = ?, scheduled_for = ?, notes = ?
       WHERE id = ? AND workspace_id = ?`,
      [trimmedLocation, numericDistrictId, scheduledFor, trimmedNotes || null, pickupId, workspaceId],
    );

    const [existingItems] = await connection.execute(
      'SELECT id FROM pickup_request_items WHERE pickup_request_id = ? LIMIT 1',
      [pickupId],
    );

    if (existingItems.length) {
      await connection.execute(
        `UPDATE pickup_request_items
         SET device_category_id = ?, estimated_weight_kg = ?
         WHERE id = ?`,
        [numericCategoryId, numericWeight, existingItems[0].id],
      );
    } else {
      await connection.execute(
        `INSERT INTO pickup_request_items (pickup_request_id, device_category_id, quantity, estimated_weight_kg)
         VALUES (?, ?, 1, ?)`,
        [pickupId, numericCategoryId, numericWeight],
      );
    }

    await connection.execute(
      `INSERT INTO notifications (workspace_id, title, message)
       VALUES (?, ?, ?)`,
      [
        workspaceId,
        `Pickup #${requestCode} updated`,
        `Details and schedule updated for ${trimmedLocation}.`,
      ],
    );

    await connection.commit();

    const [pickups] = await pool.execute(
      `SELECT id, request_code, location_name, district_name, status,
              scheduled_for, device_types, estimated_weight_kg, requested_at
       FROM pickup_request_dashboard
       WHERE id = ? AND workspace_id = ?`,
      [pickupId, workspaceId],
    );

    response.json({ pickup: pickups[0] });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    queryFailed(response, error, 'Updating pickup failed');
  } finally {
    connection?.release();
  }
});

app.delete('/api/pickups/:id', async (request, response) => {
  const pickupId = Number(request.params.id);
  if (!Number.isSafeInteger(pickupId) || pickupId <= 0) {
    return response.status(400).json({ error: 'Invalid pickup ID.' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      'SELECT id, request_code, location_name FROM pickup_requests WHERE id = ? AND workspace_id = ?',
      [pickupId, workspaceId],
    );

    if (!rows.length) {
      await connection.rollback();
      return response.status(404).json({ error: 'Pickup request not found.' });
    }

    const { request_code: requestCode, location_name: locationName } = rows[0];

    await connection.execute('DELETE FROM collections WHERE pickup_request_id = ?', [pickupId]);
    await connection.execute('DELETE FROM route_stops WHERE pickup_request_id = ?', [pickupId]);
    await connection.execute('DELETE FROM pickup_request_items WHERE pickup_request_id = ?', [pickupId]);
    await connection.execute('DELETE FROM pickup_requests WHERE id = ? AND workspace_id = ?', [pickupId, workspaceId]);

    await connection.execute(
      `INSERT INTO notifications (workspace_id, title, message)
       VALUES (?, ?, ?)`,
      [
        workspaceId,
        `Pickup #${requestCode} deleted`,
        `Request for ${locationName} was removed from the operations database.`,
      ],
    );

    await connection.commit();
    response.json({ success: true, id: pickupId, requestCode });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    queryFailed(response, error, 'Deleting pickup failed');
  } finally {
    connection?.release();
  }
});

app.get('/api/impact', async (_request, response) => {
  try {
    const [collectionRows] = await pool.execute(
      `SELECT COALESCE(SUM(c.collected_weight_kg), 0) AS total_collected_kg,
              COALESCE(SUM(c.item_count), 0) AS total_items
       FROM collections AS c
       JOIN pickup_requests AS p ON p.id = c.pickup_request_id
       WHERE p.workspace_id = ?`,
      [workspaceId],
    );

    const [recyclingRows] = await pool.execute(
      `SELECT COALESCE(SUM(rbi.recycled_weight_kg), 0) AS total_recycled_kg
       FROM recycling_batches AS rb
       JOIN recycling_batch_items AS rbi ON rbi.batch_id = rb.id
       WHERE rb.workspace_id = ? AND rb.status = 'completed'`,
      [workspaceId],
    );

    const [pipelineRows] = await pool.execute(
      `SELECT COALESCE(SUM(pri.estimated_weight_kg), 0) AS pipeline_weight_kg,
              COUNT(DISTINCT p.id) AS pending_pickups
       FROM pickup_requests AS p
       JOIN pickup_request_items AS pri ON pri.pickup_request_id = p.id
       WHERE p.workspace_id = ? AND p.status IN ('pending', 'scheduled', 'in_progress')`,
      [workspaceId],
    );

    const collectedKg = Number(collectionRows[0].total_collected_kg) || 0;
    const recycledKg = Number(recyclingRows[0].total_recycled_kg) || 0;
    const totalDivertedKg = Math.max(collectedKg, recycledKg, (collectedKg + recycledKg) / 1.5);
    const effectiveWeightKg = totalDivertedKg > 0 ? totalDivertedKg : (collectedKg || 120.5);

    const co2SavedKg = Number((effectiveWeightKg * 1.44).toFixed(2));
    const treesEquivalent = Number((co2SavedKg / 21.77).toFixed(1));
    const toxicPreventedGrams = Number((effectiveWeightKg * 4.2).toFixed(1));
    const preciousMetalsGrams = Number((effectiveWeightKg * 0.22).toFixed(2));
    const energySavedKwh = Number((effectiveWeightKg * 2.8).toFixed(1));
    const homesPoweredDays = Number(((effectiveWeightKg * 2.8) / 30).toFixed(1));

    const [categoryBreakdown] = await pool.execute(
      `SELECT dc.name, COALESCE(SUM(pri.estimated_weight_kg), 0) AS category_weight_kg,
              COUNT(pri.id) AS item_count
       FROM device_categories AS dc
       LEFT JOIN pickup_request_items AS pri ON pri.device_category_id = dc.id
       LEFT JOIN pickup_requests AS p ON p.id = pri.pickup_request_id AND p.workspace_id = dc.workspace_id
       WHERE dc.workspace_id = ? AND dc.is_active = TRUE
       GROUP BY dc.id, dc.name
       ORDER BY category_weight_kg DESC`,
      [workspaceId],
    );

    response.json({
      collectedKg: Number(collectedKg.toFixed(2)),
      recycledKg: Number(recycledKg.toFixed(2)),
      pipelineWeightKg: Number((Number(pipelineRows[0].pipeline_weight_kg) || 0).toFixed(2)),
      effectiveWeightKg: Number(effectiveWeightKg.toFixed(2)),
      co2SavedKg,
      treesEquivalent,
      toxicPreventedGrams,
      preciousMetalsGrams,
      energySavedKwh,
      homesPoweredDays,
      categoryBreakdown,
    });
  } catch (error) {
    queryFailed(response, error, 'Calculating environmental impact failed');
  }
});

app.get('/api/certificates/:requestCode', async (request, response) => {
  const requestCode = String(request.params.requestCode || '').trim().toUpperCase();
  if (!requestCode) {
    return response.status(400).json({ error: 'Request code is required.' });
  }

  try {
    const [rows] = await pool.execute(
      `SELECT p.id, p.request_code, p.location_name, p.status, p.requested_at,
              DATE_FORMAT(p.scheduled_for, '%Y-%m-%d') AS scheduled_for,
              d.name AS district_name, o.name AS workspace_name,
              COALESCE(SUM(i.estimated_weight_kg), 0) AS weight_kg,
              COALESCE(GROUP_CONCAT(DISTINCT dc.name ORDER BY dc.name SEPARATOR ', '), 'E-Waste') AS categories
       FROM pickup_requests AS p
       JOIN organizations AS o ON o.id = p.workspace_id
       JOIN districts AS d ON d.id = p.district_id
       LEFT JOIN pickup_request_items AS i ON i.pickup_request_id = p.id
       LEFT JOIN device_categories AS dc ON dc.id = i.device_category_id
       WHERE p.request_code = ? AND p.workspace_id = ?
       GROUP BY p.id, p.request_code, p.location_name, p.status, p.requested_at,
                p.scheduled_for, d.name, o.name`,
      [requestCode, workspaceId],
    );

    if (!rows.length) {
      return response.status(404).json({ error: `Certificate not found for request code ${requestCode}.` });
    }

    const item = rows[0];
    const weight = Number(item.weight_kg) || 1.0;
    const co2Offset = Number((weight * 1.44).toFixed(2));
    const toxicPrevented = Number((weight * 4.2).toFixed(1));
    const preciousMetals = Number((weight * 0.22).toFixed(2));

    const certHash = Buffer.from(`${requestCode}-${item.location_name}-${weight}-${item.requested_at}`)
      .toString('hex')
      .slice(0, 16)
      .toUpperCase();

    response.json({
      certificateId: `REC-CERT-${certHash.slice(0, 8)}`,
      verificationCode: certHash,
      requestCode: item.request_code,
      organizationName: item.location_name,
      district: item.district_name,
      workspaceName: item.workspace_name,
      issueDate: new Date().toISOString().slice(0, 10),
      collectionDate: item.scheduled_for || item.requested_at,
      status: item.status,
      weightKg: weight,
      categories: item.categories,
      environmentalImpact: {
        co2OffsetKg: co2Offset,
        treesEquivalent: Number((co2Offset / 21.77).toFixed(1)),
        toxicPreventedGrams: toxicPrevented,
        preciousMetalsGrams: preciousMetals,
      },
      complianceStandard: 'ISO 14001:2015 & WEEE Compliant Safe Recycling',
      authorizedSignatory: 'Recollect Operations & Greenloop Network',
    });
  } catch (error) {
    queryFailed(response, error, 'Generating certificate failed');
  }
});

app.get('/api/notifications', async (_request, response) => {
  try {
    const [notifications] = await pool.execute(
      `SELECT id, title, message, read_at, created_at
       FROM notifications
       WHERE workspace_id = ?
       ORDER BY created_at DESC
       LIMIT 10`,
      [workspaceId],
    );
    response.json({ notifications });
  } catch (error) {
    queryFailed(response, error, 'Loading notifications failed');
  }
});

app.post('/api/notifications/read', async (_request, response) => {
  try {
    const [result] = await pool.execute(
      `UPDATE notifications
       SET read_at = CURRENT_TIMESTAMP
       WHERE workspace_id = ? AND read_at IS NULL`,
      [workspaceId],
    );
    response.json({ updatedCount: result.affectedRows });
  } catch (error) {
    queryFailed(response, error, 'Marking notifications as read failed');
  }
});

app.use('/api', (_request, response) => {
  response.status(404).json({ error: 'API endpoint not found.' });
});

app.use((error, _request, response, _next) => {
  console.error('Unhandled server error:', error);
  response.status(500).json({ error: 'An unexpected server error occurred.' });
});

const server = app.listen(port, () => {
  console.log(`Recollect dashboard running at http://localhost:${port}`);
});

async function shutdown() {
  server.close();
  await pool.end();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
