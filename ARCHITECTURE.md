# Fest 26 / Ella Street Festival — Booking System Architecture

> **Audience:** Developers maintaining or extending this system.  
> **Version:** v3.0 (Cloud Native / Tailwind)  
> **Last updated:** February 2026

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Tech Stack](#2-tech-stack)
3. [Repository Structure](#3-repository-structure)
4. [Instances & Data Separation](#4-instances--data-separation)
5. [Authentication & Roles](#5-authentication--roles)
6. [Module Architecture (JS)](#6-module-architecture-js)
7. [Page Catalogue](#7-page-catalogue)
8. [Database Schema (Supabase)](#8-database-schema-supabase)
9. [Email System](#9-email-system)
10. [Public Booking Forms](#10-public-booking-forms)
11. [Deployment](#11-deployment)
12. [Key Configuration Files](#12-key-configuration-files)
13. [Common Maintenance Tasks](#13-common-maintenance-tasks)

---

## 1. System Overview

This is the **Ella Street Festival 2026 Stall Booking System** — a web-based admin panel that lets festival organisers manage trader applications from submission through to confirmed stall allocation.

### High-level flow

```
Public Trader                                Admin Team
─────────                                    ──────────
Fills in booking form           ──►  Booking appears in Kanban board
(Food/General/Misc)                    ↓
                                   Admin reviews + changes status
                                   (Pending → Confirmed / Rejected)
                                       ↓
                                   Confirmation email sent directly
                                   via Edge Function (Zoho Mail API)
                                       ↓
                                   Admin assigns physical location
                                       ↓
                                   Location email sent directly
                                       ↓
                                   Payment tracked (paid / unpaid)
```

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Vanilla HTML + JavaScript (ES Modules) |
| **Styling** | Tailwind CSS (compiled to `css/output.css`) |
| **Database / Auth** | Supabase (PostgreSQL + Row Level Security) |
| **File Storage** | Supabase Storage bucket (`esf-documents`) |
| **Email Delivery** | Zoho Mail API via Supabase Edge Function (`send-email`) |
| **Hosting** | Vercel (`stallbookingstailwinds.vercel.app`) |
| **Bot Protection** | Cloudflare Turnstile (on public forms) |
| **Map** | Leaflet.js (visitor-facing map view) |

---

## 3. Repository Structure

```
/
├── index.html                  ← Admin Hub (home page, requires login)
├── login.html                  ← Admin login page
├── kanban_m.html               ← Kanban board (main workflow view)
├── summary.html                ← List/table view of all bookings
├── payments.html               ← Payment tracking page
├── stats.html                  ← Statistics/charts page
├── location_admin.html         ← Assign bookings to physical spots
├── visitor_map.html            ← Public preview map (Leaflet)
├── hcc_dashboard.html          ← HCC Council checks tracker
├── more.html                   ← Email templates + booking editor
├── update_details.html         ← Edit an individual booking
├── add_misc.html               ← Add misc facility (barriers, etc.)
├── email_admin.html            ← Browse and manage the email queue
├── manage_users.html           ← Manage admin/steward user roles
├── steward.html                ← Steward view (schedule management)
├── steward_login.html          ← Separate login for stewards
│
├── General_Booking.html        ← PUBLIC: General/Non-Food booking form
├── Food_Stall_booking.html     ← PUBLIC: Food stall booking form
├── cancel_booking.html         ← PUBLIC: Self-service cancellation page
│
├── supabase-public.js          ← Supabase credentials for public pages
├── email_templates.js          ← Fallback/legacy email template config
│
├── css/
│   ├── input.css               ← Tailwind directives (source)
│   └── output.css              ← Compiled Tailwind (load this in HTML)
│
├── js/                         ← All admin JavaScript modules
│   ├── config.js               ← ⭐ Single source of truth for all config
│   ├── supabase.js             ← Supabase client + auth helpers
│   ├── api.js                  ← All database operations (CRUD)
│   ├── shared.js               ← Shared business logic (email, status)
│   ├── utils.js                ← Validation, sanitisation, rate limiting
│   ├── ui.js                   ← Toast notifications + UI helpers
│   ├── nav.js                  ← Injected navigation header
│   ├── kanban.js               ← Kanban board render/drag-drop logic
│   ├── summary.js              ← List view + detail pane logic
│   ├── payments.js             ← Payment grid logic
│   ├── stats.js                ← Statistics charts logic
│   ├── locations.js            ← Location admin drag-drop assignment
│   ├── map.js                  ← Leaflet map rendering
│   ├── details.js              ← Detail/edit pane shared component
│   ├── page-*.js               ← Entry-point scripts (one per HTML page)
│   └── ...
│
└── GAS/                        ← Google Apps Script (keep-alive)
    └── Main.gs                 ← Keep-alive database pinger (pingDatabase)
```

---

## 4. Instances & Data Separation

The system manages **multiple booking types** within a single Supabase database by using an `instance_prefix` column on every booking record. This means you can switch between datasets without touching the database.

| Instance Key | Prefix | Description |
|---|---|---|
| `DEV` | `ESF26-DEV-` | Test/development data (safe to experiment on) |
| `FOOD` | `ESF26-FOOD-` | Food stall applications |
| `GENERAL` | `ESF26-NONFOOD-` | General/non-food trader applications |
| `MISC` | `ESF26-MISC-` | Non-bookable facilities (barriers, first aid, etc.) |

The **active instance** is stored in `localStorage` under the key `ESF_INSTANCE`. The nav header provides a dropdown to switch between them — the page reloads and all queries use the new prefix automatically.

### Key rule
> Booking IDs follow the format `ESF26-{TYPE}-{NNNN}` (e.g. `ESF26-FOOD-0042`).  
> The validator in `utils.js → validateBookingId()` enforces this pattern.

---

## 5. Authentication & Roles

Authentication uses **Supabase Auth** (email + password). There are two user types, stored in the `user_roles` table:

| Role | Access |
|---|---|
| `admin` | Full access to all admin pages |
| `steward` | Access only to `steward.html` (schedule management) |

### How auth works on each page

1. **Admin pages** include `<script type="module" src="./js/page-xxx.js">` which calls `requireAuth('admin')` from `supabase.js` before loading any data.
2. `requireAuth()` checks the Supabase session, then queries `user_roles` to verify the role.
3. If not logged in → redirected to `login.html`.
4. If logged in but wrong role → redirected to `login.html?error=unauthorized`.

### Public pages (no auth required)
`General_Booking.html`, `Food_Stall_booking.html`, and `cancel_booking.html` use `supabase-public.js` (non-module script) and Cloudflare Turnstile for bot protection. They do **not** use ES modules.

### Audit logging
Every significant admin action is written to the `audit_logs` table via `api.js → auditLog()`. This includes: login, logout, status changes, emails sent, location assignments, payment updates.

---

## 6. Module Architecture (JS)

The `js/` folder uses **ES Modules** (`type="module"` scripts). There is a clear dependency hierarchy:

```
config.js          (no imports — top of the tree)
    ↑
utils.js           (no imports from this project)
    ↑
supabase.js        (imports config.js)
    ↑
api.js             (imports supabase.js, config.js, utils.js)
    ↑
ui.js              (no project imports)
shared.js          (imports supabase.js, api.js, ui.js, utils.js, config.js)
nav.js             (imports config.js, supabase.js)
    ↑
[feature modules]  (kanban.js, summary.js, payments.js, etc.)
    ↑
page-*.js          (entry points — one per HTML page)
```

### Module responsibilities

| File | Purpose |
|---|---|
| `config.js` | **Single source of truth** for all constants: instance prefixes, URLs, bank details, stall costs, status lists, Supabase credentials |
| `supabase.js` | Creates/caches the Supabase client; `requireAuth()` guards protected pages; `signOut()` logs audit trail then redirects |
| `api.js` | All direct database reads/writes. Every function validates input before touching the DB. Audit-logs every mutation. |
| `shared.js` | Business logic used by multiple pages: status update workflow, email template rendering, location email queuing, detail pane population |
| `utils.js` | Input validation (`validateString`, `validateEmail`, `validateBookingId`, `validateStatus`), HTML escaping (`escapeHtml`), URL sanitisation, email rate limiter |
| `ui.js` | `showToast()` — displays bottom-right notification. Auto-injects the toast container if not present in DOM. |
| `nav.js` | `initNavigation()` — injects the header HTML into `#nav-container`, wires up the instance selector and sign-out buttons |
| `page-*.js` | Entry point for each HTML page. Calls `requireAuth()`, then calls `initNavigation()`, then initialises the page-specific feature module |

---

## 7. Page Catalogue

### Admin pages (require login)

| Page | File | Purpose |
|---|---|---|
| **Hub** | `index.html` | Landing page with links to all modules |
| **Kanban Board** | `kanban_m.html` + `kanban.js` | Drag-and-drop workflow: columns per status (Pending, Confirmed, etc.) |
| **List View** | `summary.html` + `summary.js` | Searchable/filterable table of all bookings with a slide-in detail pane |
| **Location Manager** | `location_admin.html` + `locations.js` | Assign confirmed bookings to numbered pitch slots; shows power requirements |
| **Payment Tracker** | `payments.html` + `payments.js` | Mark bookings as paid/unpaid, record bank reference |
| **Statistics** | `stats.html` + `stats.js` | Charts and counts broken down by status, type, etc. |
| **Visitor Map** | `visitor_map.html` + `map.js` | Leaflet map showing confirmed stall locations |
| **HCC Dashboard** | `hcc_dashboard.html` + `page-hcc-dashboard.js` | Tracks council (HCC) food safety checks — only visible if there are entries |
| **More** | `more.html` | Email template editor + booking detail editor |
| **Email Admin** | `email_admin.html` | View/retry emails in the queue |
| **Manage Users** | `manage_users.html` | Add/remove admin and steward role assignments |
| **Steward View** | `steward.html` + `page-steward.js` | Schedule drag-and-drop (restricted to steward role) |

### Public pages (no login)

| Page | Purpose |
|---|---|
| `General_Booking.html` | Booking form for general/non-food traders |
| `Food_Stall_booking.html` | Booking form for food vendors |
| `cancel_booking.html` | Traders can self-cancel using their unique `cancel_token` link |

---

## 8. Database Schema (Supabase)

### Core tables

#### `bookings`
The main table. Every booking (regardless of type) lives here, distinguished by `instance_prefix`.

| Column | Type | Notes |
|---|---|---|
| `id` | text (PK) | e.g. `ESF26-FOOD-0042` |
| `instance_prefix` | text | e.g. `ESF26-FOOD-` — separates data sets |
| `status` | text | `Pending`, `Confirmed`, `Rejected`, `Cancelled`, `On Hold`, `HCC Checks` |
| `business_name` | text | Trading name |
| `owner_name` | text | Contact name |
| `email` | text | Contact email |
| `phone` | text | Contact phone |
| `category` | text | e.g. `Street Food`, `Clothing` |
| `stall_type` | text | e.g. `Food`, `Non-Food`, `Attraction` |
| `description` | text | Trader's description of their stall |
| `power_required` | text | Power requirement or `No power` |
| `address` | text | Trader's address |
| `is_resident` | boolean | Is the trader a local resident? |
| `is_charity` | text | `Commercial`, `Charity`, or `Not for profit` |
| `location_id` | text | Assigned pitch (e.g. `A12`) — null until allocated |
| `stall_cost` | numeric | Final confirmed cost |
| `admin_notes` | text | Internal notes visible only to admins |
| `documents` | text/array | URLs to uploaded documents in Supabase Storage |
| `cancel_token` | text | Unique token for self-cancellation link |
| `created_at` | timestamptz | Auto-set |
| `date_confirmed` | timestamptz | Set when status → Confirmed |
| `rejection_reason` | text | Set when status → Rejected |

#### `payments`
Created automatically when a booking is confirmed as chargeable.

| Column | Notes |
|---|---|
| `booking_id` | FK to `bookings.id` |
| `stall_cost` | Cost at time of confirmation |
| `paid` | boolean |
| `date_paid` | When payment was received |
| `bank_ref` | Bank transfer reference |
| `editor` | Who marked it as paid |

#### `locations`
Reference data for physical pitches on the festival site.

| Column | Notes |
|---|---|
| `id` | Pitch identifier (e.g. `A12`) |
| `dataset` | `DEV` or `LIVE` — keeps test and production maps separate |
| `lat` / `lng` | GPS coordinates for the map |
| `type` | Pitch type (food, general, etc.) |
| `power` | Indicates if power is available |

#### `email_queue`
Log of emails sent (or failed) via the Supabase Edge Function.

| Column | Notes |
|---|---|
| `recipient` | Email address |
| `subject` | Email subject line |
| `body` | HTML email body |
| `status` | `Sent`, `Error` |
| `instance_prefix` | Identifies which festival instance sent the email |
| `error_message` | Set if sending fails |

#### `email_templates`
HTML email templates stored in the database (editable via the More page).

| Column | Notes |
|---|---|
| `id` | Template key e.g. `confirmed_chargeable`, `rejected`, `location_update`, `payment_reminder` |
| `subject` | Subject with `{{placeholders}}` |
| `body_html` | HTML body with `{{placeholders}}` |

Supported placeholders: `{{owner_name}}`, `{{business_name}}`, `{{booking_id}}`, `{{cancel_link}}`, `{{cost}}`, `{{bank_details}}`, `{{location_id}}`, `{{reason}}`

#### `audit_logs`
Immutable record of all admin actions.

| Column | Notes |
|---|---|
| `action` | e.g. `update_status`, `email_queued`, `admin_login` |
| `target_id` | The booking ID acted on (or `system`) |
| `user_email` | Admin who performed the action |
| `details` | JSON blob with action-specific data |
| `instance` | Which instance was active |

#### `hcc_checks`
Entries automatically created when a booking is moved to `HCC Checks` status.

#### `user_roles`
Row per user granting admin or steward access.

| Column | Notes |
|---|---|
| `id` | Must match the Supabase Auth `user.id` |
| `role` | `admin` or `steward` |

---

## 9. Email System

Emails are sent using a **secure serverside Edge Function**:

```
Admin action (e.g. Confirm booking)
        │
        ▼
api.js → sendEmail()
        │
        ▼
Supabase Edge Function (send-email)
→ Requests Zoho Mail API token
→ Sends email via Zoho API
→ Logs transaction to email_queue table (status: Sent/Error)
```

### Email templates
Templates live in the `email_templates` Supabase table. The function `shared.js → getEmailFromTemplate()` fetches the template, substitutes `{{placeholder}}` variables, and returns the final `{subject, body}`.

### When emails are triggered automatically

| Trigger | Template used |
|---|---|
| Booking status → `Confirmed` (chargeable) | `confirmed_chargeable` |
| Booking status → `Confirmed` (free) | `confirmed_free` |
| Booking status → `Rejected` | `rejected` |
| Location assigned (manual action) | `location_update` |
| Manual resend by admin | varies |
| Manual payment reminder | `payment_reminder` |

### Google Apps Script setup
The GAS folder contains a keep-alive script (`GAS/Main.gs`) with the `pingDatabase` function. It is designed to be set up on a daily time-driven trigger in Google Apps Script to keep the free-tier Supabase database from pausing due to inactivity.

---

## 10. Public Booking Forms

The three public-facing pages (`General_Booking.html`, `Food_Stall_booking.html`, `cancel_booking.html`) work differently from admin pages:

- They use `<script src="supabase-public.js">` (a **non-module** script) because they need to be accessible to the public without an auth session
- They include Cloudflare Turnstile widget for bot protection (`TURNSTILE_SITE_KEY` in `supabase-public.js`)
- Files uploaded by traders go to the **Supabase Storage** bucket `esf-documents`
- File size limit is **12 MB**
- Booking IDs are auto-generated on the client in the format `ESF26-FOOD-NNNN` (sequentially, by checking the highest existing ID)

> ⚠️ The public Supabase anon key is intentionally visible in the client. Security is enforced entirely by **Row Level Security (RLS) policies** in Supabase, not by keeping the key secret.

---

## 11. Deployment

The app is deployed on **Vercel**. Every push to the connected Git branch triggers an automatic deployment.

- **Production URL:** `https://stallbookingstailwinds.vercel.app`
- Configuration: `.vercel/` directory contains project/environment linkage
- Tailwind CSS must be **compiled before committing** — run `npm run build` (or the equivalent in `package.json`) to regenerate `css/output.css` from `css/input.css`

### Building Tailwind CSS
```bash
npm install
npx tailwindcss -i ./css/input.css -o ./css/output.css --watch
# or for one-off build:
npx tailwindcss -i ./css/input.css -o ./css/output.css
```

---

## 12. Key Configuration Files

### `js/config.js` — The single source of truth

Everything environment-specific lives here. **If you change the Vercel URL or Supabase credentials, update this file first.**

```
CONFIG.SUPABASE.URL / KEY      ← Supabase project credentials
CONFIG.URLS.BASE               ← Vercel deployment URL
CONFIG.URLS.CANCEL_URL         ← Direct link to cancel_booking.html
CONFIG.BANK_ACCOUNT_NAME/SORT_CODE/ACCOUNT_NUMBER ← Bank details printed in emails (loaded from the settings table, not hardcoded)
CONFIG.UI.STATUS_LIST          ← Valid status values
CONFIG.INSTANCE_MAP            ← Maps instance keys to DB prefixes
```

This file contains the Supabase credentials and other global configuration settings. It is the single source of truth for public configurations, as `js/config.js` imports and references `ESF_PUBLIC_CONFIG` from this file.

### `email_templates.js` — Legacy fallback

This file contains hardcoded email template strings as a fallback. The primary templates are now stored in the Supabase `email_templates` table and managed via the admin UI. This file is kept for reference / emergency fallback.

---

## 13. Common Maintenance Tasks

### Rotating the Supabase anon key
1. Generate new key in Supabase dashboard → Project Settings → API
2. Update `SUPABASE_KEY` (and `SUPABASE_URL` if needed) in `supabase-public.js`
3. Re-deploy to Vercel

### Changing the bank account details
Update the "Bank Transfer Payment Details" card on `settings.html` (writes `bank_account_name`/`bank_sort_code`/`bank_account_number` to the `settings` table). These are automatically composed into the `{{bank_details}}` placeholder used by confirmation emails, and individually available as `{{bank_account_name}}`/`{{bank_sort_code}}`/`{{bank_account_number}}` for the payment-request email.

### Changing stall prices
Update the Stall Costs section on `settings.html` (writes `stall_cost_food`/`stall_cost_general`/`stall_cost_dev` to the `settings` table). There are no hardcoded defaults in code — `getStallCost()` reads entirely from the settings table (falling back to 0 with a console warning if a value hasn't loaded).

### Adding a new admin user
1. The user must first create a Supabase Auth account (or be invited via Supabase dashboard)
2. Go to `manage_users.html` and add their Supabase user ID with role `admin`

### Adding a new email template
1. Insert a row into the `email_templates` table in Supabase
2. Give it a unique `id` string (e.g. `my_new_template`)
3. Use `{{owner_name}}`, `{{business_name}}`, etc. as placeholders
4. Call `getEmailFromTemplate('my_new_template', booking, id)` from JS

### Changing the Vercel URL
1. Update the `base_url` and `cancel_url` values in the database `settings` table.
2. Update `BASE_URL` and `CANCEL_URL` in `supabase-public.js` (which serves as the local configuration and emergency fallback).

### Adding a new booking status
1. Add the new status string to `CONFIG.UI.STATUS_LIST` in `config.js`
2. Add a colour mapping to `CONFIG.UI.STATUS_COLORS`
3. Add a colour to the `VALID_STATUSES` array in `utils.js`
4. Update the Kanban column definitions in `kanban.js` if it needs its own column

### Keeping Supabase active (free tier)
The GAS `Main.gs` includes a `pingDatabase()` function. Set it up as a daily time-driven trigger in GAS to prevent Supabase pausing the project after 7 days of inactivity.

---

*For questions about specific features, refer to the inline JSDoc comments in each file in `js/`.*
