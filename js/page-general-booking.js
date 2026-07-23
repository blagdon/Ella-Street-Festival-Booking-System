import { getPublicSupabaseClient, initPublicPage, ESF_PUBLIC_CONFIG } from '../supabase-public.js';
import { escapeHtml, parseEdgeFunctionError } from './utils.js';

// initPublicPage has already awaited loadPublicSettings() (cache-first,
// DB on cold cache) before this callback runs.
initPublicPage(async function () {
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

    const PREFIX = (ESF_PUBLIC_CONFIG?.BOOKING_PREFIX || "ESF26") + "-NONFOOD-";

    // Check if bookings are open dynamically from Supabase
    async function checkBookingsOpen() {
        try {
            const { data, error } = await sb
                .from('settings')
                .select('value')
                .eq('key', 'general_bookings_open')
                .single();
            if (error) throw error;
            if (data && data.value !== 'true') {
                document.getElementById('form-section')?.classList.add('hidden');
                document.getElementById('closed-section')?.classList.remove('hidden');
            }
        } catch (err) {
            console.warn("Failed to check if bookings are open:", err?.message || err);
        }
    }
    checkBookingsOpen();

    // --- BTN START NEW ---
    const btnStartNew = document.getElementById('btn-start-new');
    if (btnStartNew) {
        btnStartNew.addEventListener('click', () => { window.location.reload(); });
    }

    // --- UI HELPERS ---
    const descInput = document.querySelector('textarea[name="description"]');
    if (descInput) {
        descInput.addEventListener('input', e => {
            document.getElementById('descCount').innerText = `${e.target.value.length}/200`;
        });
    }

    // "Other" Category Logic (Checkbox based)
    const otherInput = document.getElementById('catOtherInput');
    const otherCheck = document.getElementById('catOtherCheck');

    if (otherCheck && otherInput) {
        otherCheck.addEventListener('change', e => {
            if (e.target.checked) {
                otherInput.disabled = false;
                otherInput.focus();
            } else {
                otherInput.disabled = true;
                otherInput.value = '';
            }
        });
    }

    // --- SERVER-SIDE ID GENERATION ---
    async function generateNextId() {
        const { data, error } = await sb.rpc('get_next_booking_id', { p_prefix: PREFIX });
        if (error) throw new Error("ID Generation Failed: " + error.message);
        return data;
    }

    // --- SUBMIT HANDLER ---
    const form = document.getElementById('nonFoodForm');

    if (form) {
        form.addEventListener('submit', async function (e) {
            // STOP THE RELOAD
            e.preventDefault();

            const btn = document.getElementById('submitBtn');
            const msg = document.getElementById('statusMessage');
            const catError = document.getElementById('categoryError');

            // Reset errors
            catError.classList.add('hidden');

            // Check at least one category selected
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
                const captchaToken = document.querySelector('[name="cf-turnstile-response"]');
                if (!captchaToken || !captchaToken.value) {
                    throw new Error("Please complete the CAPTCHA verification.");
                }

                const formData = new FormData(form);

                // 1. Generate Temp UUID
                const tempUuid = (self.crypto && self.crypto.randomUUID) ? self.crypto.randomUUID() : Math.random().toString(36).substring(2, 15) + Date.now().toString(36);

                // 2. Upload Files (Optional, up to 5 files)
                const BUCKET_NAME = window.ESF_PUBLIC_CONFIG ? window.ESF_PUBLIC_CONFIG.BUCKET_NAME : 'esf-documents';
                const fileInput = document.getElementById('fileUpload');
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
                }

                // 3. Prepare Data Object

                // Handle Category (Multiple -> Single String)
                let selectedCategories = [];
                checkedCats.forEach(cb => {
                    if (cb.value === 'Other') {
                        const otherVal = document.getElementById('catOtherInput').value.trim();
                        if (otherVal) selectedCategories.push(`Other: ${otherVal}`);
                    } else {
                        selectedCategories.push(cb.value);
                    }
                });
                const categoryString = selectedCategories.join(', ');

                // Construct checklist string
                let checklistArr = [];
                if (formData.get('pli_check')) checklistArr.push("Public Liability Insurance (£5m)");
                if (formData.get('hygiene_check')) checklistArr.push("Agreed to Hull City Council Hygiene Regs");
                if (formData.get('data_protection_check')) checklistArr.push("Agreed to Data Protection Notice");

                const sbData = {
                    instance_prefix: PREFIX,
                    status: 'Pending',
                    stall_type: 'Non-Food',

                    // Business
                    business_name: formData.get('business_name'),
                    owner_name: formData.get('owner_name'),

                    // Contact
                    email: formData.get('email'),
                    phone: formData.get('phone'),
                    address: formData.get('address'),
                    website: formData.get('website'),

                    // Details
                    description: formData.get('description'),
                    other_requirements: formData.get('other_requirements'),

                    // Attributes
                    category: categoryString,
                    is_charity: formData.get('charity_status'),
                    is_resident: formData.get('is_resident') === 'true',

                    // Documents - store as JSON array for PostgreSQL
                    docs_checklist: checklistArr.join(', '),
                };

                // 4. Call Secure Edge Function
                btn.innerText = "Saving Booking...";

                const { data, error } = await sb.functions.invoke('submit-booking', {
                    body: {
                        token: captchaToken.value, // Pass the Turnstile token to the backend
                        bookingData: sbData,       // Pass the booking object
                        tempUuid: tempUuid,
                        fileNames: fileNames
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

                // 5. Success - SWITCH VIEW
                const boolYesNo = (val) => val ? '<span class="text-green-600 font-bold">Yes</span>' : 'No';

                const detailsHtml = `
              <div class="sm:col-span-1"><dt class="text-sm font-medium text-gray-500">Trading Name</dt><dd class="mt-1 text-sm text-gray-900">${escapeHtml(sbData.business_name)}</dd></div>
              <div class="sm:col-span-1"><dt class="text-sm font-medium text-gray-500">Owner</dt><dd class="mt-1 text-sm text-gray-900">${escapeHtml(sbData.owner_name)}</dd></div>
              
              <div class="sm:col-span-1"><dt class="text-sm font-medium text-gray-500">Email</dt><dd class="mt-1 text-sm text-gray-900">${escapeHtml(sbData.email)}</dd></div>
              <div class="sm:col-span-1"><dt class="text-sm font-medium text-gray-500">Phone</dt><dd class="mt-1 text-sm text-gray-900">${escapeHtml(sbData.phone)}</dd></div>
              
              <div class="sm:col-span-1"><dt class="text-sm font-medium text-gray-500">Category</dt><dd class="mt-1 text-sm text-gray-900">${escapeHtml(sbData.category)}</dd></div>
              <div class="sm:col-span-1"><dt class="text-sm font-medium text-gray-500">Charity Status</dt><dd class="mt-1 text-sm text-gray-900">${escapeHtml(sbData.is_charity)}</dd></div>

              <div class="sm:col-span-1"><dt class="text-sm font-medium text-gray-500">Resident</dt><dd class="mt-1 text-sm text-gray-900">${boolYesNo(sbData.is_resident)}</dd></div>
              <div class="sm:col-span-1"></div>

              <div class="sm:col-span-2"><dt class="text-sm font-medium text-gray-500">Description</dt><dd class="mt-1 text-sm text-gray-900">${escapeHtml(sbData.description)}</dd></div>

              ${sbData.website ? `<div class="sm:col-span-2"><dt class="text-sm font-medium text-gray-500">Website / Social Media</dt><dd class="mt-1 text-sm text-gray-900 break-words">${escapeHtml(sbData.website)}</dd></div>` : ''}

              ${sbData.other_requirements ? `<div class="sm:col-span-2"><dt class="text-sm font-medium text-gray-500">Other Notes</dt><dd class="mt-1 text-sm text-gray-900">${escapeHtml(sbData.other_requirements)}</dd></div>` : ''}
          `;

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

                if (typeof turnstile !== 'undefined') turnstile.reset();
            }
        });
    }
});
