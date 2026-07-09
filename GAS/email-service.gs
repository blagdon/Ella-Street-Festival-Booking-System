// ===================================================================
// === EMAIL SERVICE (Supabase Cloud-Native Edition) ===
// ===================================================================

/**
 * Adds an email to the Supabase-backed queue with an instance tag.
 * This ensures the email is picked up only by the correct Gmail account.
 */
function addToQueue(to, subject, body, bcc) {
  try {
    const payload = {
      recipient: to,
      subject: subject,
      body: body,
      bcc: bcc || null,
      status: 'Pending',
      // The tag that isolates emails between Food, General, and Dev accounts
      instance_prefix: CONFIG.BOOKING_ID_PREFIX 
    };

    // Insert directly into Supabase email_queue table
    Supabase.insert('email_queue', payload);
  } catch (err) {
    console.error("Failed to queue email in Supabase: " + err.message);
  }
}

/**
 * Processes the email queue for the SPECIFIC active instance.
 * Triggered by the 1-minute heartbeat (setupTriggers in Main.gs).
 */
function processEmailQueue() {
  let pendingEmails = [];
  
  try {
    // 1. Fetch 'Pending' emails that match THIS account's prefix
    // Honors the batch size limit defined in Config.gs
    const query = `?status=eq.Pending&instance_prefix=eq.${CONFIG.BOOKING_ID_PREFIX}&limit=${CONFIG.LIMITS.EMAIL_BATCH_SIZE}`;
    pendingEmails = Supabase.select('email_queue', query);
  } catch (err) {
    console.error("Queue Fetch Error: " + err.message);
    return;
  }

  if (!pendingEmails || pendingEmails.length === 0) return;

  pendingEmails.forEach(email => {
    try {
      const options = {
        // Convert newlines to HTML line breaks for the Gmail send
        htmlBody: email.body.replace(/\n/g, '<br>'),
        name: CONFIG.APP_NAME
      };
      
      if (email.bcc) options.bcc = email.bcc;

      // 2. Send the Email via the active Gmail session
      // Uses plain text (stripping tags) as a fallback
      MailApp.sendEmail(email.recipient, email.subject, email.body.replace(/<[^>]+>/g, ''), options);

      // 3. Update Status to Sent in the shared database
      Supabase.update('email_queue', email.id, { 
        status: 'Sent',
        error_message: null 
      });

    } catch (e) {
      console.error(`Failed to send email ${email.id}: ` + e.message);
      
      // Update with error details for admin visibility
      Supabase.update('email_queue', email.id, { 
        status: 'Error',
        error_message: e.message 
      });
    }
    
    // Safety delay to prevent hitting Google's send-rate limits
    Utilities.sleep(CONFIG.LIMITS.RETRY_DELAY_MS || 1000);
  });
}

// --- TEMPLATE ENGINE ---

/**
 * Generates a pre-filled link to your Squarespace Cancellation Page.
 */
/**
 * Generates a clean link for the Squarespace Cancellation Page.
 * Output format: .../cancel?bookingId=ESF26-FOOD-101&email=owner@example.com
 */
function generateCancellationLink(bookingId, email) {
  // ⚠️ IMPORTANT: Replace this with the exact link to your Squarespace page
  const baseUrl = "https://www.ellastreet.co.uk/fest26/stallcancel"; 
  
  if (!baseUrl) return "#";

  // We use simple names 'bookingId' and 'email' which the website script expects
  const params = `?bookingId=${encodeURIComponent(bookingId)}&email=${encodeURIComponent(email)}`;
  
  return baseUrl + params;
}

/**
 * Merges booking data into an HTML template and queues it for sending.
 */
function sendEmailFromTemplate(toEmail, templateObj, data) {
  if (!toEmail || !templateObj) return;

  let subject = templateObj.SUBJECT;
  let body = templateObj.BODY;

  const cancelLink = generateCancellationLink(data.id, toEmail);

  const replacements = {
    "%NAME%": data.name || "",
    "%BIZ%": data.biz || "",
    "%ID%": data.id || "",
    "%LOCATION%": data.location || "TBA",
    "%REASON%": data.reason || "",
    "%CANCEL_LINK%": cancelLink,
    "%BANK_DETAILS%": CONFIG.BANK_DETAILS || "",
    "%COST%": CONFIG.STALL_COST || "£50"
  };

  // Iterative replacement for all placeholders in the template
  for (const [key, value] of Object.entries(replacements)) {
    const regex = new RegExp(key, "g");
    subject = subject.replace(regex, value);
    body = body.replace(regex, value);
  }

  addToQueue(toEmail, subject, body);
}