// @ts-check
import { getPublicSupabaseClient, initPublicPage } from '../supabase-public.js';
import { initPublicBookingForm } from './public-context.js';
import { escapeHtml, parseEdgeFunctionError, guardUnsavedForm } from './utils.js';

/**
 * Shows the closed-section with a reason-specific message, replacing its
 * default "Bookings Closed / ran out of space" copy only when the reason is
 * something other than the plain org-level toggle being off (that case's
 * default HTML copy is still accurate as-is).
 * @param {'not_found' | 'event_not_open' | 'toggle_closed'} reason
 * @param {string} [eventStatus]
 */
function showClosed(reason, eventStatus) {
    document.getElementById('form-section')?.classList.add('hidden');
    const heading = document.getElementById('closed-section-heading');
    const body = document.getElementById('closed-section-body');
    if (reason === 'not_found') {
        if (heading) heading.textContent = 'Booking Link Not Found';
        if (body) body.textContent = "This booking link is no longer valid. Check the address, or contact the organiser who sent it to you.";
    } else if (reason === 'event_not_open') {
        if (heading) heading.textContent = 'Not Currently Accepting Applications';
        if (body) body.textContent = `This event is currently in '${(eventStatus || '').toUpperCase()}' mode and isn't open for applications yet. Please check back later.`;
    }
    document.getElementById('closed-section')?.classList.remove('hidden');
}

// initPublicPage runs with { loadSettings: false } here: this page resolves
// its own org/event context from the URL first (initPublicBookingForm), and
// loads that organisation's settings itself - the auto-loaded default
// org_default settings initPublicPage would otherwise fetch are the wrong
// organisation's the moment a real org/event slug is present.
initPublicPage(async function () {
    const boot = await initPublicBookingForm('food_bookings_open');
    if (boot.ok === false) {
        showClosed(boot.reason, /** @type {any} */ (boot).eventStatus);
        return;
    }

    // Only touches the DOM when a real event was resolved from a slug -
    // boot.orgName/eventName are undefined for the legacy default case, so
    // the page's own static "Ella Street Festival 2026" copy is left alone.
    if (boot.eventName) {
        const subtitle = document.getElementById('event-context-subtitle');
        if (subtitle) subtitle.textContent = `${boot.orgName} — ${boot.eventName}`;
        document.title = `Food & Drink Trader Application — ${boot.eventName}`;
    }

    // Regulatory Authority (V1.1 Sprint 1, Issue 2) — only touches the DOM
    // when the org/event actually has a configured value; otherwise the
    // static generic fallback text already in the HTML stands as-is.
    if (boot.regulatoryAuthorityName) {
        const el = document.getElementById('regulatoryAuthorityText');
        if (el) el.innerHTML = `all <strong>${escapeHtml(boot.regulatoryAuthorityName)} Food and Hygiene Regulations</strong>`; // innerhtml-safe: escapeHtml applied
    }
    if (boot.insuranceMinimumAmount) {
        const el = document.getElementById('insuranceMinimumText');
        if (el) el.innerHTML = `a minimum indemnity of <strong>${escapeHtml(boot.insuranceMinimumAmount)}</strong>`; // innerhtml-safe: escapeHtml applied
    }

    // Tenant branding (V1.1 Sprint 2, Issue 2) — this form previously showed
    // no organisation identity at all beyond the text subtitle above, even
    // when the org had a logo/colour configured. Only touches the DOM when a
    // value is actually set; an unbranded org sees exactly today's page.
    if (boot.logoUrl) {
        const logo = /** @type {HTMLImageElement|null} */ (document.getElementById('bookingOrgLogo'));
        if (logo) {
            logo.alt = boot.orgName || '';
            logo.src = boot.logoUrl;
            logo.classList.remove('hidden');
            // addEventListener, not onerror= — this app's CSP has no
            // 'unsafe-inline' for script-src (see js/page-event.js's org
            // logo for the same pattern).
            logo.addEventListener('error', () => logo.classList.add('hidden'));
        }
    }
    if (boot.primaryColor) {
        const btn = document.getElementById('submitBtn');
        if (btn) btn.style.backgroundColor = boot.primaryColor;
    }

    const sb = getPublicSupabaseClient();

    // Bind Turnstile Key from database dynamically
    const siteKey = window.ESF_PUBLIC_CONFIG?.TURNSTILE_SITE_KEY;
    if (siteKey) {
        document.querySelectorAll('.cf-turnstile').forEach(el => {
            el.setAttribute('data-sitekey', siteKey);
        });
    }

    // Dynamically load Turnstile script
    const script = document.createElement('script');
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);

    // --- CONFIGURATION ---
    const PREFIX = boot.bookingPrefix + "-FOOD-";

    // --- BTN START NEW ---
    const btnStartNew = document.getElementById('btn-start-new');
    if (btnStartNew) {
        btnStartNew.addEventListener('click', () => { window.location.reload(); });
    }

    // --- UI HELPERS ---

    // Counter for description
    const descInput = document.querySelector('textarea[name="description"]');
    if (descInput) {
        descInput.addEventListener('input', e => {
            document.getElementById('descCount').innerText = `${(/** @type {HTMLTextAreaElement} */ (e.target)).value.length}/200`;
        });
    }

    // "Other" Category Logic (Checkbox based)
    const otherInput = /** @type {HTMLInputElement | null} */ (document.getElementById('catOtherInput'));
    const otherCheck = /** @type {HTMLInputElement | null} */ (document.getElementById('catOtherCheck'));

    if (otherCheck && otherInput) {
        otherCheck.addEventListener('change', e => {
            if ((/** @type {HTMLInputElement} */ (e.target)).checked) {
                otherInput.disabled = false;
                otherInput.focus();
            } else {
                otherInput.disabled = true;
                otherInput.value = '';
            }
        });
    }

    // --- SUBMIT HANDLER ---
    const form = /** @type {HTMLFormElement | null} */ (document.getElementById('foodForm'));

    if (form) {
        const unsavedGuard = guardUnsavedForm(form);

        form.addEventListener('submit', async function (e) {
            e.preventDefault();

            const btn = /** @type {HTMLButtonElement} */ (document.getElementById('submitBtn'));
            const msg = /** @type {HTMLElement} */ (document.getElementById('statusMessage'));
            const catError = /** @type {HTMLElement} */ (document.getElementById('categoryError'));

            // Reset errors
            catError.classList.add('hidden');

            // Custom Validation: Check at least one category selected
            const checkedCats = document.querySelectorAll('input[name="category_check"]:checked');
            if (checkedCats.length === 0) {
                catError.classList.remove('hidden');
                catError.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
            }

            btn.disabled = true;
            btn.innerText = "Processing...";
            msg.classList.add('hidden');

            try {
                // 0. Verify CAPTCHA
                const captchaToken = /** @type {HTMLInputElement | null} */ (document.querySelector('[name="cf-turnstile-response"]'));
                if (!captchaToken || !captchaToken.value) {
                    throw new Error("Please complete the CAPTCHA verification.");
                }

                const formData = new FormData(form);

                // 1. Generate Temp UUID
                const tempUuid = (self.crypto && self.crypto.randomUUID) ? self.crypto.randomUUID() : Math.random().toString(36).substring(2, 15) + Date.now().toString(36);

                // 2. Upload Files (up to 5 files, at least 1 required)
                const BUCKET_NAME = window.ESF_PUBLIC_CONFIG ? window.ESF_PUBLIC_CONFIG.BUCKET_NAME : 'esf-documents';
                const fileInput = /** @type {HTMLInputElement} */ (document.getElementById('fileUpload'));
                let fileNames = [];

                if (fileInput.files.length > 0) {
                    // Validate file count
                    if (fileInput.files.length > 5) {
                        throw new Error("Maximum 5 files allowed");
                    }

                    btn.innerText = "Uploading Files...";

                    // Upload each file
                    for (let i = 0; i < fileInput.files.length; i++) {
                        const file = fileInput.files[i];

                        // Check individual file size (5MB limit)
                        if (file.size > 5 * 1024 * 1024) {
                            throw new Error(`File "${file.name}" exceeds 5MB limit`);
                        }

                        // Check file type
                        const validTypes = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
                        const ext = file.name.split('.').pop().toLowerCase();
                        const validExts = ['jpg', 'jpeg', 'png', 'pdf'];
                        if (!validTypes.includes(file.type) && !validExts.includes(ext)) {
                            throw new Error(`File "${file.name}" has an invalid type (${file.type}). Only JPG, PNG, and PDF are allowed.`);
                        }

                        // Create unique filename with timestamp to avoid conflicts
                        const timestamp = Date.now();
                        const safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
                        const fileName = `${timestamp}_${safeName}`;
                        const filePath = `temp/${tempUuid}/${fileName}`;

                        btn.innerText = `Uploading File ${i + 1} of ${fileInput.files.length}...`;

                        const { error: upErr } = await sb.storage.from(BUCKET_NAME).upload(filePath, file, { upsert: false });
                        if (upErr) throw new Error(`Upload failed for "${file.name}": ${upErr.message}`);

                        fileNames.push(fileName);
                    }
                } else {
                    // Fallback if HTML required attribute failed
                    throw new Error("Please upload at least one document (insurance certificate required).");
                }

                // 3. Prepare Data Object

                // Handle Category 
                let selectedCategories = [];
                checkedCats.forEach(cbEl => {
                    const cb = /** @type {HTMLInputElement} */ (cbEl);
                    if (cb.value === 'Other') {
                        const otherVal = (/** @type {HTMLInputElement} */ (document.getElementById('catOtherInput'))).value.trim();
                        if (otherVal) selectedCategories.push(`Other: ${otherVal}`);
                    } else {
                        selectedCategories.push(cb.value);
                    }
                });
                const categoryString = selectedCategories.join(', ');

                // Construct checklist string
                let checklistArr = [];
                if (formData.get('pli_check')) checklistArr.push(`Public Liability Insurance${boot.insuranceMinimumAmount ? ` (${boot.insuranceMinimumAmount})` : ''}`);
                if (formData.get('hygiene_check')) checklistArr.push(`Agreed to ${boot.regulatoryAuthorityName || 'applicable'} Hygiene Regs`);
                if (formData.get('data_protection_check')) checklistArr.push("Agreed to Data Protection Notice");

                const sbData = {
                    instance_prefix: PREFIX,
                    status: 'Pending',
                    stall_type: 'Food',

                    // Business Identifiers
                    business_name: formData.get('business_name'),
                    registered_business_name: formData.get('registered_business_name'),
                    owner_name: formData.get('owner_name'),

                    // Contact
                    email: formData.get('email'),
                    phone: formData.get('phone'),
                    address: formData.get('address'),

                    // Stall Details
                    description: formData.get('description'),
                    category: categoryString,
                    website: formData.get('website'),

                    // Booleans & Dropdowns
                    is_charity: formData.get('charity_status'),
                    is_resident: formData.get('is_resident') === 'true',
                    power_required: formData.get('power_required'),

                    // Docs
                    docs_checklist: checklistArr.join(', '),

                    // Other
                    other_requirements: formData.get('other_requirements')
                };

                // 4. Call Secure Edge Function
                btn.innerText = "Saving Booking...";

                const { data, error } = await sb.functions.invoke('submit-booking', {
                    body: {
                        token: captchaToken.value, // Pass the Turnstile token to the backend
                        bookingData: sbData,       // Pass the booking object
                        tempUuid: tempUuid,
                        fileNames: fileNames,
                        // Server re-resolves org/event from these slugs itself -
                        // never trusted as an id. undefined for the legacy
                        // default-event case, same as submit-booking's own default.
                        orgSlug: boot.orgSlug,
                        eventSlug: boot.eventSlug
                    }
                });

                if (error) {
                    throw new Error(await parseEdgeFunctionError(error, "Server error"));
                }
                if (data && data.error) {
                    throw new Error(data.error); // Catch Cloudflare rejection messages
                }

                const returnedBooking = data?.data?.[0] || data?.[0];
                const finalBookingId = returnedBooking ? returnedBooking.id : "TBA";

                // 6. Success - HIDE FORM, SHOW SUMMARY

                const boolYesNo = (val) => val ? '<span class="text-green-600 font-bold">Yes</span>' : 'No';

                const detailsHtml = `
              <div class="sm:col-span-1"><dt class="text-sm font-medium text-gray-500">Trading Name</dt><dd class="mt-1 text-sm text-gray-900">${escapeHtml(sbData.business_name)}</dd></div>
              <div class="sm:col-span-1"><dt class="text-sm font-medium text-gray-500">Registered Name</dt><dd class="mt-1 text-sm text-gray-900">${escapeHtml(sbData.registered_business_name || 'N/A')}</dd></div>
              
              <div class="sm:col-span-1"><dt class="text-sm font-medium text-gray-500">Owner</dt><dd class="mt-1 text-sm text-gray-900">${escapeHtml(sbData.owner_name)}</dd></div>
              <div class="sm:col-span-1"><dt class="text-sm font-medium text-gray-500">Email</dt><dd class="mt-1 text-sm text-gray-900">${escapeHtml(sbData.email)}</dd></div>
              
              <div class="sm:col-span-1"><dt class="text-sm font-medium text-gray-500">Category</dt><dd class="mt-1 text-sm text-gray-900">${escapeHtml(sbData.category)}</dd></div>
              <div class="sm:col-span-1"><dt class="text-sm font-medium text-gray-500">Charity Status</dt><dd class="mt-1 text-sm text-gray-900">${escapeHtml(sbData.is_charity)}</dd></div>

              <div class="sm:col-span-1"><dt class="text-sm font-medium text-gray-500">Power</dt><dd class="mt-1 text-sm text-gray-900">${escapeHtml(sbData.power_required)}</dd></div>
              <div class="sm:col-span-1"><dt class="text-sm font-medium text-gray-500">Resident</dt><dd class="mt-1 text-sm text-gray-900">${boolYesNo(sbData.is_resident)}</dd></div>

              <div class="sm:col-span-2"><dt class="text-sm font-medium text-gray-500">Description</dt><dd class="mt-1 text-sm text-gray-900">${escapeHtml(sbData.description)}</dd></div>

              ${sbData.website ? `<div class="sm:col-span-2"><dt class="text-sm font-medium text-gray-500">Website / Social Media</dt><dd class="mt-1 text-sm text-gray-900 break-words">${escapeHtml(sbData.website)}</dd></div>` : ''}

              ${sbData.other_requirements ? `<div class="sm:col-span-2"><dt class="text-sm font-medium text-gray-500">Other Requirements</dt><dd class="mt-1 text-sm text-gray-900">${escapeHtml(sbData.other_requirements)}</dd></div>` : ''}
              
              <div class="sm:col-span-2"><dt class="text-sm font-medium text-gray-500">Files</dt><dd class="mt-1 text-sm text-gray-900">${(returnedBooking && returnedBooking.documents) ? 'Insurance Certification Uploaded' : 'None'}</dd></div>
          `;

                unsavedGuard.markSubmitted();

                document.getElementById('success-ref').innerText = finalBookingId;
                document.getElementById('success-details').innerHTML = detailsHtml;

                document.getElementById('form-section').classList.add('hidden');
                document.getElementById('success-section').classList.remove('hidden');

                window.scrollTo(0, 0);

            } catch (err) {
                console.error(err);
                msg.className = "mt-6 p-4 rounded-lg bg-red-50 text-red-700 border border-red-200";
                msg.innerText = "Error: " + err.message;
                msg.classList.remove('hidden');

                btn.disabled = false;
                btn.innerText = "Submit Application";
            } finally {
                if (typeof turnstile !== 'undefined' && document.getElementById('form-section').classList.contains('hidden') === false) {
                    turnstile.reset();
                }
            }
        });
    }
}, { loadSettings: false });
