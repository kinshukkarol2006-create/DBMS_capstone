# Recollect dashboard

The frontend is served by a Node.js API backed by MySQL. MySQL credentials
stay on the server in `.env`; they are never sent to the browser.

## Requirements

- Node.js 18 or newer
- MySQL 8.0.16 or newer

## Configure MySQL

1. Start MySQL Server.
2. Create the database:

   ```sql
   CREATE DATABASE recollect CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
   ```

3. Open `database.sql` in MySQL Workbench while connected as a MySQL user with
   permission to create tables and views. Select `recollect` as the default
   schema, and run the whole script. It creates the tables, reporting views,
   and sample Greenloop workspace.
4. Create the server environment file:

   ```sh
   cp .env.example .env
   ```

5. Set `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` in `.env`
   to match your MySQL server. For local MySQL installations the usual host and
   port are `127.0.0.1` and `3306`; `DB_USER` and `DB_PASSWORD` depend on your
   local MySQL account. `WORKSPACE_ID=1` selects the sample workspace.
   Use the username and password for your MySQL account. The app does not read
   credentials saved inside Workbench. For safer separation, run `database.sql`
   as an administrator, then create a limited runtime account in Workbench:

   ```sql
   CREATE USER 'recollect_app'@'localhost' IDENTIFIED BY 'choose-a-password';
   GRANT SELECT, INSERT, UPDATE, DELETE ON recollect.* TO 'recollect_app'@'localhost';
   ```

   Then set `DB_USER=recollect_app` and `DB_PASSWORD` to the password you chose
   in `.env`. Do not put database credentials in frontend JavaScript.

## Run the dashboard

```sh
npm install
npm start
```

Open <http://localhost:3000>, then check <http://localhost:3000/api/health>.
The health endpoint should return `{"status":"ok","database":"connected","engine":"mysql"}`.
After changing `.env`, stop and restart `npm start` so Node.js reloads the
settings.

The API exposes `/api/health`, `/api/dashboard`, `/api/volume`, `/api/options`,
`/api/pickups`, `/api/pickups/export`, `/api/routes`, `/api/recycling`,
`/api/partners`, and `/api/notifications` with `POST /api/notifications/read`.
New pickup requests are saved to MySQL in a transaction. Exports are capped at
5,000 matching pickup requests.

`file://` pages cannot use this API setup; always open the dashboard from the
Node server at `http://localhost:3000`. Do not expose the development server
to the public internet without adding authentication and authorization.

## Use a separate sample database

To display the bundled Greenloop sample data without changing the existing
`recollect` database:

1. Run `create_sample_database.sql` in MySQL Workbench. It creates and selects
   the separate `recollect_sample` database.
2. Select `recollect_sample` as the default schema, then run all of
   `database.sql` to create its tables, views, and sample data.
3. Set `DB_NAME=recollect_sample` in `.env`, keeping your valid MySQL username
   and password, then restart the Node server.

The sample data script is safe to run again. The original `recollect` database
is not changed by these steps.
# DBMS_capstone
