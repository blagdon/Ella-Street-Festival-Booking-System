# Ella Street Festival 2026 — Admin User Guide

> This guide is for festival organisers using the booking system day-to-day.  
> No technical knowledge required.

---

## Table of Contents

1. [Logging In](#1-logging-in)
2. [The Admin Hub](#2-the-admin-hub)
3. [Switching Between Booking Types](#3-switching-between-booking-types)
4. [Kanban Board — Managing Applications](#4-kanban-board--managing-applications)
5. [List View — Searching & Filtering Bookings](#5-list-view--searching--filtering-bookings)
6. [Reviewing a Booking (Detail Pane)](#6-reviewing-a-booking-detail-pane)
7. [Confirming a Booking](#7-confirming-a-booking)
8. [Rejecting a Booking](#8-rejecting-a-booking)
9. [Other Statuses (On Hold, HCC Checks, Cancelled)](#9-other-statuses-on-hold-hcc-checks-cancelled)
10. [Location Manager — Assigning Pitch Slots](#10-location-manager--assigning-pitch-slots)
11. [Payment Tracker](#11-payment-tracker)
12. [HCC Dashboard (Council Checks)](#12-hcc-dashboard-council-checks)
13. [Statistics](#13-statistics)
14. [Visitor Map](#14-visitor-map)
15. [Email Admin — Monitoring the Email Queue](#15-email-admin--monitoring-the-email-queue)
16. [Editing a Booking](#16-editing-a-booking)
17. [Adding a Misc Facility](#17-adding-a-misc-facility)
18. [Managing Admin Users](#18-managing-admin-users)
19. [Steward Accounts](#19-steward-accounts)
20. [Frequently Asked Questions](#20-frequently-asked-questions)
21. [Setting Up a New Organisation & Branding](#21-setting-up-a-new-organisation--branding)
22. [Location Management — Adding & Editing Pitches](#22-location-management--adding--editing-pitches)
23. [Event Configuration — Different Settings for One Event](#23-event-configuration--different-settings-for-one-event)
24. [Sharing Your Event's Booking Forms](#24-sharing-your-events-booking-forms)

---

## 1. Logging In

1. Go to `https://stallbookingstailwinds.vercel.app/login.html`
2. Enter your email address and password, then click **Sign In**
3. You'll be taken to the Admin Hub

**Forgot your password?** Click *Forgot password?* on the login page, enter your email, and a reset link will be sent to your inbox. After clicking the link you'll be prompted to set a new password.

> ⚠️ After 5 failed login attempts the form will lock for 30 seconds for security.

**To sign out:** click **Sign Out** in the top-right corner of any page (or in the mobile menu).

---

## 2. The Admin Hub

The hub (`index.html`) is your home screen. It shows a card for each module:

| Card | What it does |
|---|---|
| **Kanban Board** | Visual drag-and-drop view of all applications by status |
| **List View (Summary)** | Searchable table of all bookings |
| **HCC Checks** | Appears only when bookings are awaiting council approval |
| **Location Manager** | Assign confirmed traders to physical pitch numbers |
| **Payment Tracker** | Mark payments as received |
| **Statistics** | Charts and counts |
| **Visitor Map** | Preview the public Leaflet map |
| **More** | Email template editor and booking details editor |

Click any card to open that module.

---

## 3. Switching Between Booking Types

The system manages **four separate datasets** that can be switched using the **Database** dropdown in the top navigation bar:

| Option | What it shows |
|---|---|
| 🛠️ **DEV (Test Data)** | Safe sandbox — use this for testing. Changes here don't affect real bookings. |
| 🍔 **FOOD Stalls** | Food vendor applications |
| 🎨 **GENERAL Traders** | Non-food / general trader applications |
| ⚡ **MISC (Facilities)** | Non-bookable entries: barriers, first aid posts, etc. |

> ✅ The current dataset is always shown as a coloured badge next to the site title.  
> The page reloads automatically when you switch — your data is never mixed between types.

**On mobile:** tap the hamburger menu (☰) in the top-right to reveal the database selector.

---

## 4. Kanban Board — Managing Applications

The Kanban board at `kanban_m.html` shows all bookings as cards organised into columns by their status.

### Columns

| Column | Meaning |
|---|---|
| **Pending** | New — not yet reviewed |
| **On Hold** | Needs more info / awaiting a decision |
| **HCC Checks** | Sent to council for food safety approval |
| **Confirmed** | Accepted — email sent automatically |
| **Rejected** | Declined — rejection email sent automatically |
| **Cancelled** | Trader cancelled their own booking |

### Moving a booking
**Drag the card** from one column to another. A confirmation popup will appear for the most consequential moves (Confirm, Reject).

### Opening a booking
**Click a card** to open the detail pane on the right. You can see all the trader's information, their documents, and take actions from there.

### Filtering
Use the search box at the top to filter cards by business name, owner name, or booking ID. Cards that don't match will be hidden.

---

## 5. List View — Searching & Filtering Bookings

The List View at `summary.html` shows all bookings in a table format — useful for bulk review or finding a specific booking quickly.

- **Search bar:** filters by business name, owner, email, or booking ID as you type
- **Status filter:** dropdown to show only bookings with a specific status
- **Sort:** click column headers to sort
- **Click any row** to open the detail pane on the right with full information and action buttons

---

## 6. Reviewing a Booking (Detail Pane)

When you click a booking card or table row, a panel slides in showing:

- Business name, owner, email, phone, address
- Category and stall type
- Power requirements
- Description of the stall
- Whether the trader is a local resident or charity
- Uploaded documents (clickable links)
- Current assigned location
- Admin notes (editable text box — auto-saves when you click **Save Notes**)
- Action buttons (Confirm, Reject, etc.)

---

## 7. Confirming a Booking

1. Open the booking using the Kanban board or List View
2. Click **Confirm** in the detail pane  
   (or drag the card to the **Confirmed** column on Kanban)
3. A popup appears asking:
   - Is this booking **chargeable** or **free**?
   - If chargeable — what is the cost? (the default from config is pre-filled)
4. Click **Confirm**

**What happens automatically:**
- The booking status is set to `Confirmed`
- A payment record is created (if chargeable)
- A confirmation email is queued and sent to the trader via Gmail within ~1 minute
- The `date_confirmed` timestamp is recorded

> 📧 The confirmation email uses the template `confirmed_chargeable` or `confirmed_free` from the database.

---

## 8. Rejecting a Booking

1. Open the booking
2. Click **Reject** (or drag to the **Rejected** column on Kanban)
3. A popup appears — you can optionally type a **reason** (this is included in the rejection email)
4. Click **Reject**

**What happens automatically:**
- Status is set to `Rejected`
- The assigned location is cleared
- A rejection email is queued using the `rejected` template, including your reason

---

## 9. Other Statuses (On Hold, HCC Checks, Cancelled)

### On Hold
Use this when a booking needs more information or a decision is deferred. No email is sent automatically.

### HCC Checks
Moving a booking to **HCC Checks** does two things:
1. Sets the status
2. Automatically creates an entry in the **HCC Dashboard** so you can track the council approval progress separately

No email is sent to the trader when this status is set.

### Cancelled
Set by the system when a trader cancels their own booking via the cancellation link in their email. You can also set it manually. No automated email is sent for admin-initiated cancellation.

---

## 10. Location Manager — Assigning Pitch Slots

The Location Manager at `location_admin.html` lets you assign each confirmed booking to a specific numbered pitch.

### How to assign a pitch
1. The left panel shows **unassigned confirmed bookings**
2. The right panel shows the **site map** with pitch slots
3. **Drag a booking** from the left onto an available pitch slot on the right
4. The booking is saved and the pitch is marked as occupied

### Sending a location email
Once a location is assigned, click **Email Location** (or the envelope icon on the booking). This queues a `location_update` email to the trader telling them their pitch number.

### Visual cues
- **Green slots** — available
- **Red/occupied slots** — already assigned
- Power icons (⚡) indicate a pitch has power available
- The badge in the header shows global occupancy across all booking types

---

## 11. Payment Tracker

The Payment Tracker at `payments.html` shows all confirmed **chargeable** bookings and their payment status.

> ℹ️ This page always shows **all live booking types** (Food + General + Misc) together. DEV data is kept separate.

### Marking a payment as received
1. Find the booking in the table
2. Tick the **Paid** checkbox
3. Enter the **bank reference** (optional but recommended)
4. Enter your **name/initials** in the Editor field
5. Click **Save**

The record is updated immediately and the `date_paid` timestamp is set.

### Columns
| Column | Meaning |
|---|---|
| **Business** | Trading name |
| **Type** | Food / Non-Food |
| **Cost** | The agreed stall fee |
| **Paid** | ✅ tick = payment received |
| **Date Paid** | When it was marked as paid |
| **Bank Ref** | Bank transfer reference |
| **Editor** | Who recorded the payment |

---

## 12. HCC Dashboard (Council Checks)

The HCC Dashboard at `hcc_dashboard.html` tracks food safety approvals from Hastings Borough Council.

It only appears on the Hub when there are bookings in `HCC Checks` status.

### Using the dashboard
- Each row shows a trader that has been sent for council review
- Update the **Council Status** for each entry (e.g. Pending → Approved / Rejected)
- Add notes in the notes column
- Once the council decision is confirmed, return to the Kanban board to continue processing the booking

---

## 13. Statistics

The Statistics page at `stats.html` gives a visual breakdown of all bookings across all instances:

- Total applications by status (pie/bar chart)
- Breakdown by stall type and category
- Applications over time
- Confirmed vs pending ratio

Use the instance selector to focus on a specific booking type.

---

## 14. Visitor Map

The Visitor Map at `visitor_map.html` shows a Leaflet map with markers for all **confirmed** bookings that have been assigned a location.

- Click a marker to see the business name and stall type
- This is a preview of what the **public-facing map** will look like
- Locations are pulled from the `locations` table in the database

---

## 15. Email Admin — Monitoring the Email Queue

The Email Admin page at `email_admin.html` lets you see all emails in the queue and their status.

| Status | Meaning |
|---|---|
| **Pending** | Waiting to be picked up by Google Apps Script |
| **Sent** | Successfully delivered by Gmail |
| **Error** | Failed — check the error message column |

### If an email failed
1. Note the error message in the table
2. You can re-queue the email by using **Resend Confirmation** or **Send Payment Reminder** buttons in the booking's detail pane
3. If the GAS script has stopped running, a developer will need to check the trigger configuration in Google Apps Script

### Email delivery timing
Emails are typically sent within **1–2 minutes** of being queued. If an email is stuck in `Pending` for more than 5 minutes, the GAS trigger may need to be restarted.

---

## 16. Editing a Booking

To correct a trader's details after submission:

1. Open the booking (Kanban or List View)
2. Click **Edit Details** in the detail pane
3. You'll be taken to `update_details.html` with the booking pre-loaded
4. Update any fields and click **Save Changes**

Fields you can edit: business name, owner name, email, phone, category, description, stall type, power requirement, address, resident status, charity status.

> ⚠️ Editing does not re-send any emails. If the trader's email address changes, you may want to manually resend a confirmation using the **Resend Confirmation** button.

---

## 17. Adding a Misc Facility

MISC entries are used for non-bookable items on the site map: barriers, first aid posts, police, fire engines, toilets, etc.

1. Click **More** from the Hub
2. Click **Add Misc Entry** (or go to `add_misc.html` directly)
3. Fill in the name and type
4. Click **Add**

The entry is created with a `ESF26-MISC-XXXX` ID and `Confirmed` status so it appears on the location map immediately. No email is sent for MISC entries.

---

## 18. Managing Admin Users

Go to `manage_users.html` (linked from the **More** page).

### Adding a new admin
1. The person must first have a Supabase account — either they sign up via the login page (or are invited via Supabase)
2. Get their **Supabase User ID** (visible in the Supabase dashboard under Authentication → Users)
3. On the Manage Users page, enter their User ID and select role `admin`
4. Click **Add**

### Removing an admin
Click the **Delete** (🗑️) button next to their name. This removes their admin access only — it does **not** delete their Supabase account.

### Roles available
| Role | Access |
|---|---|
| `admin` | Full access to all admin pages |
| `steward` | Access to the steward schedule view only |

---

## 19. Steward Accounts

Stewards are volunteers who access `steward.html` to view and manage the event schedule. They use a **separate login page** at `steward_login.html`.

Stewards **cannot** see bookings, payments, or any admin data — they only see the schedule.

**To create a steward account:**
1. Follow the same steps as adding an admin user (section 18)
2. Select role `steward` instead of `admin`

---

## 20. Frequently Asked Questions

**Q: A trader says they didn't receive their confirmation email. What do I do?**  
A: Open their booking in the Kanban or List View. In the detail pane, click **Resend Confirmation**. Check their email address is correct — if not, use **Edit Details** to fix it first, then resend.

---

**Q: I confirmed a booking but the payment tracker shows it as zero cost. Why?**  
A: The booking was probably confirmed as **free** rather than chargeable. You can manually correct this by updating the payment record in the Payment Tracker, or by contacting the developer to adjust the payment record in Supabase.

---

**Q: I moved a booking to the wrong status. Can I undo it?**  
A: Yes — open the booking and click the correct status button, or drag it back to the right column on the Kanban board. Note: if it was confirmed, a confirmation email may already have been sent to the trader.

---

**Q: An email failed to send, or the Email Admin shows an error. What do I do?**  
A: Go to the **Email Admin** page to view the logs in the email queue. If an email has an `Error` status, click on it to check the error message. Common issues include invalid trader email addresses, or expired Zoho credentials. If the Zoho credentials have expired, go to **Settings** and click **Auto-Fetch** (or re-authenticate) to refresh the OAuth connection.

---

**Q: Can I delete a booking?**  
A: There is no delete button in the UI by design — all data is kept for audit purposes. To effectively remove a booking, set its status to `Cancelled`. If you need a record permanently removed, it must be deleted directly in the Supabase database.

---

**Q: How do I test something without affecting real bookings?**  
A: Switch the database selector to **🛠️ DEV (Test Data)**. All changes in DEV mode are completely isolated from Food, General, and Misc data.

---

**Q: Where do uploaded documents go?**  
A: Trader documents (insurance certificates, food hygiene certs, etc.) are uploaded directly to Supabase Storage in the `esf-documents` bucket. Links to each document appear in the booking detail pane and can be clicked to open the file.

---

**Q: What does the cancel token do?**  
A: Every confirmation email includes a unique self-cancellation link. When the trader clicks it, it takes them to `cancel_booking.html` where they can cancel without needing admin access. The booking status is then updated to `Cancelled` automatically.

---

## 21. Setting Up a New Organisation & Branding

> This section covers the Platform Administration Workspace's Provisioning and Branding tools —
> most organisers running a single festival will never need them. They matter if the platform is
> being set up to run more than one organisation's events.

**Setting up a new organisation.** From the Admin Hub, click **Workspace**, then choose
**Provisioning** from the sidebar. There is no separate provisioning page or public sign-up form —
this wizard, reachable only to a signed-in admin, is the only way a new organisation gets created.
Walk through its five steps (Organisation details → Primary Event → a summary of what will be
cloned → a pre-flight check → the final report) and click **Provision Organisation**. This creates
the organisation, its first event, and a starter set of settings/email/SMS templates it can then
customise.

**Slug rules.** The organisation and event slugs (used in the public `/{organisation}/{event}` link,
and editable from the Organisation/Event Details forms) must be lowercase letters, numbers, and
single hyphens only — no spaces, underscores, or capital letters, and a handful of words (page
names like `admin` or `settings`, and generic ones like `api`/`www`) are reserved and can't be used.
An invalid or reserved slug is rejected immediately with a plain-English error explaining why.

**Switching which organisation you're viewing.** The header's **Org** dropdown (and, on the Platform
Administration Workspace, the Organisation selector) changes which organisation's data every admin
page shows. If you're ever looking at a Kanban board or Payments page that seems unexpectedly
empty, check this — the header badge next to it turns **amber** and shows an **↩ Primary org**
button whenever you're not viewing the main organisation, precisely so this is easy to notice and
easy to undo with one click.

**Branding.** From the Workspace sidebar, **Branding** lets you set a logo URL, accent colours, an
SMS sender name, a support email, and an email footer for the organisation you're currently viewing.
The logo appears in that organisation's admin header once saved and the page is reloaded. A newly
created organisation starts with everything blank — it will never show a previous organisation's
logo or contact details as if they were its own.

---

## 22. Location Management — Adding & Editing Pitches

The Workspace's **Locations** tab (sidebar, `admin.html`) is where the physical pitches/stalls
themselves are created and maintained — separate from the Location Manager (§10), which *assigns*
already-confirmed bookings to pitches that already exist here. Everything on this tab is scoped to
whichever organisation and event you're currently viewing.

### Adding, editing, and removing a pitch
- **+ Add Location** opens a form for an ID (e.g. `P1`, `Gate-A`), latitude/longitude, and whether
  it has a power hookup. The ID can't be changed after creation.
- **Edit** changes an existing pitch's coordinates and power flag.
- **Delete** (single, or **Delete Selected** after ticking several rows) removes a pitch. Any
  booking currently assigned to it is unassigned, not deleted.

### Duplicate, Import, and Clone
- **Duplicate** (on any row) creates a copy with `-copy` appended to the ID.
- **Import CSV** accepts a file with `id,lat,lng,has_power` columns; rows whose ID already exists
  for this event are skipped, not overwritten.
- **Clone From…** copies every pitch from another event in this organisation, or — with the right
  access — from another organisation's active event entirely, useful for starting a new event from
  a previous year's layout without re-entering every pitch by hand.
- **Export CSV** downloads the current event's pitches in the same format Import expects.

> **A duplicated, imported, or cloned ID that's already taken elsewhere is automatically renamed**
> (`P1` becomes `P1-2`, and so on) rather than the operation failing — a success message lists
> exactly which IDs were changed, so nothing is silently renamed without you knowing. This can
> happen because a generic code like `P1` may already be in use by a *different* organisation
> entirely, not just within this one.

---

## 23. Event Configuration — Different Settings for One Event

**More Tools → Event Configuration** lets you set a handful of values differently for
just the event you're currently viewing, without changing anything for your other
events or the rest of your organisation.

### What you can override

- **Festival Display Name**
- **General Stall Price**
- **Food Stall Price**
- **Developer Stall Price**
- **Allowed Stall Types**

Everything else on this page — and every other setting in the system — still comes from
your organisation's normal settings, the same as always.

### How it works

Each value on the page shows one of two labels:

- **Inherited from Organisation** — this event is using your organisation's normal
  setting. This is the default for everything, until you choose to change it.
- **Overridden for this Event** — this event has its own value, set specifically here.

To give a setting its own value for this event, turn on **Override for this event**,
type the new value, and click **Save Event Configuration**.

To go back to using your organisation's normal value, click **Reset to Organisation
Default**. This removes the event's own value entirely — it doesn't just copy your
organisation's current number over the top of it. That matters if you ever change your
organisation's price later: an event you've reset will pick up that new organisation
price automatically, the same as any event that was never overridden in the first
place.

### Booking Prefix isn't here

Booking Prefix is set per event, but from the event's own details on the
**Platform Administration** workspace (where you also set the event's name and dates)
— not from this page. If you're trying to change a booking prefix, that's where to go.

### A typical use

If you run the same festival every year but prices go up, or a special one-off event
needs its own name and pricing, turn on the overrides you need for just that event and
leave everything else following your organisation's usual settings.

---

## 24. Sharing Your Event's Booking Forms

If your organisation runs more than one event, the trader application forms can point at
a specific one: share the General or Food Stall booking form link with `?org=your-org-slug&event=your-event-slug`
added to the end (your organisation and event slugs are the ones you set up when you
created them). A trader who applies through that link is applying to that event
specifically — their application, and any email or text they receive about it, is kept
with that event and organisation.

If you only ever run one event, you don't need to do anything — the plain form links
work exactly as they always have.

### An event only accepts applications while it's Open

A trader can only submit an application while the event they're applying to is set to
**Open**. If it's still being set up (Draft), scheduled but not yet ready
(Ready), or has finished (Closed/Archived), the booking form shows a message
explaining that instead of the application form — traders never see a confusing error,
and nothing they submit is lost, because there's nothing to submit yet. Set an event's
status from its own details on the **Platform Administration** workspace, the same
place you set its name and booking prefix.

A booking link for an event that isn't real, or has been removed, shows the same
message a Draft event's link does — "this link is no longer valid" — rather than
revealing whether an event with that name almost exists.

---

*For technical issues, refer to ARCHITECTURE.md or contact the system developer.*
