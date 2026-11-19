# Recollect — E-Waste Management & Operations System
### DBMS Capstone Project

**Recollect** is an enterprise-grade electronic waste (e-waste) collection, recycling, and environmental impact management dashboard backed by **MySQL 8** and a **Node.js/Express** RESTful backend. 

Designed and engineered for a college DBMS capstone project, this application models real-world circular economy workflows aligned with **UNEP (United Nations Environment Programme)**, **EPA**, and **WEEE/RoHS** guidelines.

---

## 🌟 Key Features

### 1. Operations & Logistics Lifecycle (Full CRUD)
* **Real-time Status Transitions**: Transition collection requests through: `Pending` $\rightarrow$ `Scheduled` $\rightarrow$ `In progress` $\rightarrow$ `Completed` $\rightarrow$ `Cancelled`.
* **Automated Audit Logging**: Marking requests as `Completed` automatically logs verified item counts and weights into the `collections` audit table, dynamically updating monthly metrics and volume charts.
* **Interactive Management**: Quick status changes, editing details (weight, dates, notes, category, district), and safe deletion directly from the table or modal.

### 2. Environmental Impact & Carbon Offset Engine
Quantifies tangible ecological benefits from diverted electronic scrap using international Life Cycle Assessment (LCA) standards:
* 🌿 **GHG / $\text{CO}_2$ Avoided**: $\approx 1.44\text{ kg CO}_2\text{e}$ prevented per kg of e-waste recycled compared to raw virgin mineral extraction.
* 🌳 **Mature Tree Equivalency**: Quantifies equivalent annual carbon absorption by mature trees.
* 🛡️ **Toxic Heavy Metals Neutralized**: Prevents hazardous elements (Lead, Cadmium, Mercury, Arsenic) from leaching into soil and municipal groundwater ($4.2\text{ g/kg}$).
* ⚡ **Energy Conservation**: Measures kilowatt-hours saved ($2.8\text{ kWh/kg}$) and days of household electricity power.
* 💎 **Precious Metals Reclaimed**: Measures recoverable high-value metals (Gold, Silver, Copper, Palladium).

### 3. Official Green Recycling Certificate Generator
* Instantly generates verifiable **Certificates of Responsible E-Waste Disposal**.
* Includes unique Certificate ID, cryptographic verification hash, consigned weights, device breakdown, and environmental metrics.
* Aligned with **ISO 14001:2015 Environmental Management** and **WEEE/RoHS** compliance standards.
* One-click **Print / Save as PDF** capability.

### 4. Fleet & Route Management
* Driver assignment, scheduled dates, and sequenced route stops.
* Status tracking across planned, in-progress, and completed routes.

---

## 🗄️ Database Architecture (MySQL 8)

The relational schema is custom-engineered in **Third Normal Form (3NF)** with strict referential integrity (`ON DELETE CASCADE`, `ON DELETE RESTRICT`), foreign keys, and SQL `CHECK` constraints.

### Core Entities:
1. `organizations`: Multi-tenant hierarchy (workspaces, logistics collection partners, and material refiners).
2. `users`: Role-Based Access Control (`owner`, `manager`, `dispatcher`, `driver`, `viewer`).
3. `districts`: Regional and municipal geographical zones.
4. `device_categories`: Standardized classifications (Laptops, Mobile phones, Monitors, Desktops, Servers, Batteries, Appliances).
5. `pickup_requests`: Customer and institutional pickup consignments with unique tracking codes (`EW-XXXX`).
6. `pickup_request_items`: Line-item breakdown of quantities and weights per category.
7. `collection_routes`: Logistics schedules and assigned fleet drivers.
8. `route_stops`: Sequenced route stop stops linked to pickup requests.
9. `collections`: Immutable audit trail of completed field collections with verified weights.
10. `recycling_batches` & `recycling_batch_items`: Consigned batches refined by certified recycling partners.
11. `impact_goals`: Target monthly/quarterly recovery goals.
12. `notifications`: Real-time system alert feed.

### Pre-Aggregated Reporting Views:
* `pickup_request_dashboard`: Real-time aggregated pickup overview with concatenated device types and total estimated weights.
* `daily_collection_volume`: Unified union of daily collection and recycling weights for analytics charting.
* `monthly_device_category_totals`: Monthly breakdown of items by category for donut visualization.
* `dashboard_monthly_metrics`: High-level monthly KPI rollups.

---

## 🚀 Getting Started

### Prerequisites
* **Node.js**: v18.0 or newer
* **MySQL Server**: v8.0.16 or newer

### 1. Database Setup
1. Start your local MySQL server.
2. In MySQL Workbench or CLI, run `database.sql` (or `create_sample_database.sql` for a separate sample database).
   ```sql
   CREATE DATABASE recollect CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
   -- Then execute database.sql
   ```

### 2. Environment Configuration
Copy `.env.example` to `.env`:
```sh
cp .env.example .env
```
Configure your MySQL credentials in `.env`:
```ini
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=recollect_sample
WORKSPACE_ID=1
```

### 3. Install & Launch
```sh
# Install dependencies
npm install

# Start production server
npm start

# Or start with auto-reload (development)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser. Verify the connection at [http://localhost:3000/api/health](http://localhost:3000/api/health).

---

## 🔌 API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Health check & MySQL status |
| `GET` | `/api/dashboard` | Monthly KPIs & device category breakdown |
| `GET` | `/api/impact` | Real-time carbon, toxic material & energy savings |
| `GET` | `/api/volume?range=30D` | Time-series collection & recycling volume points |
| `GET` | `/api/pickups` | Paginated, filtered, and searchable pickup list |
| `GET` | `/api/pickups/:id` | Full details for a single pickup request |
| `POST` | `/api/pickups` | Create a new collection request |
| `PUT` | `/api/pickups/:id` | Edit details of a pickup request |
| `PATCH`| `/api/pickups/:id/status` | Update pickup status with automated notifications |
| `DELETE`| `/api/pickups/:id` | Remove a pickup request and related items |
| `GET` | `/api/certificates/:code`| Generate Green Recycling Certificate data |
| `GET` | `/api/routes` | View collection routes and assigned drivers |
| `GET` | `/api/recycling` | Recycling batches and partner material recovery |
| `GET` | `/api/partners` | Directory of collection and recycling partners |
| `GET` | `/api/notifications` | Real-time alerts and activity stream |
| `POST` | `/api/notifications/read` | Mark all notifications as read |

---

## 👥 Authors & Academic Context
* **Author**: Kinshuk Karol
* **Project**: Capstone Project for Database Management Systems (DBMS)
