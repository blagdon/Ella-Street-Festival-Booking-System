// File: Main.gs

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Festival Admin')
    .addItem('🔧 Reset & Sync Dashboard Headers', 'fullyResetAndRepopulateDashboard')
    .addSeparator()
    .addItem('Confirm Selected', 'confirmSelectedBookings')
    .addItem('Reject Selected', 'rejectSelectedBooking')
    .addSeparator()
    .addItem('Email Confirmed Stalls', 'sendCustomEmailToConfirmed')
    .addItem('Send Location Allocations', 'sendLocationUpdateEmails')
    .addSeparator()
    .addItem('Process Email Queue Now', 'processEmailQueue')
    .addToUi();
}

function doGet(e) {
  // ... (Your existing doGet logic remains unchanged) ...
  // For brevity, keeping your existing routing logic:
  const render = (filename, title, dataObj) => {
    const template = HtmlService.createTemplateFromFile(filename);
    if (dataObj) template.initialData = JSON.stringify(dataObj);
    else template.initialData = 'null';
    return template.evaluate().setTitle(title || CONFIG.APP_NAME).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL).addMetaTag('viewport', 'width=device-width, initial-scale=1');
  };

  if (e.parameter && e.parameter.page === 'kanban') {
    let boardData = [];
    try { boardData = getKanbanData(); } catch (err) {}
    return render('Kanban', "Kanban Board", boardData);
  }
  if (e.parameter && e.parameter.page === 'stats') return render('Stats', "Statistics");
  if (e.parameter && e.parameter.page === 'payments') return render('PaymentTracker', "Payment Tracker");
  if (e.parameter && e.parameter.page === 'visitor_map') return render('VisitorMap', "Festival Map");
  if (e.parameter && e.parameter.page === 'locations') return render('LocationAdmin', "Location Manager");
  if (e.parameter && e.parameter.page === 'summary') return render('BookingSummary', "Booking Summary");
  if (e.parameter && e.parameter.page === 'edit_booking') return render('EditBooking', "Editor");
  if (e.parameter && e.parameter.page === 'admin_map') return render('Map', "Internal Map");
  if (e.parameter && e.parameter.page === 'portal') return render('StallPortal', "Stallholder Portal");

  return render('Index', "Admin Hub");
}

// === NEW: IMPROVED POST HANDLER ===
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000); 

  try {
    let params = e.parameter;
    if (e.postData && e.postData.contents) {
      try {
        const json = JSON.parse(e.postData.contents);
        params = { ...params, ...json };
      } catch (e) {}
    }

    const action = params.action;

    // A. New Booking 
    if (action === 'create_booking') {
       const result = handleNewWebBooking(params);
       return createJsonResponse({ status: 'success', data: result });
    }

    // B. File Upload 
    if (action === 'upload_file') {
       const result = handleWebFileUpload(params);
       return createJsonResponse({ status: 'success', data: result });
    }

    // C. Cancellation
    if (action === 'cancel_booking') {
       const booking = handleCancellationRequest(params.bookingId, params.email, params.reason);
       return HtmlService.createHtmlOutput(`<h1>Cancelled</h1>`);
    }

    throw new Error("Unknown action: " + action);

  } catch (err) {
    return createJsonResponse({ status: 'error', message: err.message });
  } finally {
    lock.releaseLock();
  }
}

function createJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Helper to include HTML files within other HTML files.
 * Required for Kanban.html and other templates to load scripts.
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * CRON JOB: Keep-Alive Ping
 * Prevents Supabase from pausing the project due to inactivity (7-day limit on Free Tier).
 * Set this up as a "Time-driven" trigger to run once per day.
 */
function pingDatabase() {
  try {
    console.log("PING: Sending keep-alive request to Supabase...");
    
    // Perform a lightweight query (fetch just 1 ID from bookings)
    // This counts as API usage and resets the inactivity timer.
    const result = Supabase.select('bookings', '?select=id&limit=1');
    
    console.log(`PING: Success. Database is active.`);
  } catch (err) {
    console.error("PING: Failed. " + err.message);
    // Optional: Send yourself an email if the ping fails repeatedly
    // MailApp.sendEmail(Session.getActiveUser().getEmail(), "Supabase Ping Failed", err.message);
  }
}