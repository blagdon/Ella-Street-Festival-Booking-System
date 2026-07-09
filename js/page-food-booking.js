import { getPublicSupabaseClient, ESF_PUBLIC_CONFIG } from '../supabase-public.js';

// Wait for DOM to load
document.addEventListener('DOMContentLoaded', function () {

    // --- CONFIGURATION ---
    const BUCKET_NAME = ESF_PUBLIC_CONFIG.BUCKET_NAME || 'esf-documents';
    const PREFIX = "ESF26-FOOD-";
    const sb = getPublicSupabaseClient();

    // Check if bookings are open dynamically from Supabase
    async function checkBookingsOpen() {
        try {
            const { data, error } = await sb
                .from('settings')
                .select('value')
                .eq('key', 'food_bookings_open')
                .single();
            if (error) throw error;
            if (data && data.value !== 'true') {
                document.getElementById('form-section')?.classList.add('hidden');
                document.getElementById('closed-section')?.classList.remove('hidden');
            }
        } catch (err) {
            console.warn("Failed to check if bookings are open:", err);
        }
    }
    checkBookingsOpen();

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
    const form = document.getElementById('foodForm');

    if (form) {
        form.addEventListener('submit', async function (e) {
            e.preventDefault();

            const btn = document.getElementById('submitBtn');
            const msg = document.getElementById('statusMessage');
            const catError = document.getElementById('categoryError');

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
                const captchaToken = document.querySelector('[name="cf-turnstile-response"]');
                if (!captchaToken || !captchaToken.value) {
                    throw new Error("Please complete the CAPTCHA verification.");
                }

                const formData = new FormData(form);

                // 1. Get ID
                const newBookingId = await generateNextId();

                // 2. Upload Files (up to 5 files, at least 1 required)
                const BUCKET_NAME = window.ESF_PUBLIC_CONFIG ? window.ESF_PUBLIC_CONFIG.BUCKET_NAME : 'esf-documents';
                const fileInput = document.getElementById('fileUpload');
                let uploadedUrls = [];

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
                        const filePath = `${newBookingId}/${timestamp}_${safeName}`;

                        btn.innerText = `Uploading File ${i + 1} of ${fileInput.files.length}...`;

                        const { error: upErr } = await sb.storage.from(BUCKET_NAME).upload(filePath, file, { upsert: false });
                        if (upErr) throw new Error(`Upload failed for "${file.name}": ${upErr.message}`);

                        const { data } = sb.storage.from(BUCKET_NAME).getPublicUrl(filePath);
                        uploadedUrls.push(data.publicUrl);
                    }
                } else {
                    // Fallback if HTML required attribute failed
                    throw new Error("Please upload at least one document (insurance certificate required).");
                }

                // 3. Prepare Data Object

                // Handle Category 
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
                    id: newBookingId,
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

                    // Booleans & Dropdowns
                    is_charity: formData.get('charity_status'),
                    is_resident: formData.get('is_resident') === 'true',
                    power_required: formData.get('power_required'),

                    // Docs
                    docs_checklist: checklistArr.join(', '),
                    documents: uploadedUrls.length > 0 ? uploadedUrls : null,

                    // Other
                    other_requirements: formData.get('other_requirements')
                };

                // 4. Call Secure Edge Function
                btn.innerText = "Saving Booking...";

                const { data, error } = await sb.functions.invoke('submit-booking', {
                    body: {
                        token: captchaToken.value, // Pass the Turnstile token to the backend
                        bookingData: sbData        // Pass the booking object
                    }
                });

                if (error) {
                    throw new Error("Server error: " + error.message);
                }
                if (data && data.error) {
                    throw new Error(data.error); // Catch Cloudflare rejection messages
                }


                // 6. Success - HIDE FORM, SHOW SUMMARY

                const boolYesNo = (val) => val ? '<span class="text-green-600 font-bold">Yes</span>' : 'No';

                const detailsHtml = `
              <div class="sm:col-span-1"><dt class="text-sm font-medium text-gray-500">Trading Name</dt><dd class="mt-1 text-sm text-gray-900">${sbData.business_name}</dd></div>
              <div class="sm:col-span-1"><dt class="text-sm font-medium text-gray-500">Registered Name</dt><dd class="mt-1 text-sm text-gray-900">${sbData.registered_business_name || 'N/A'}</dd></div>
              
              <div class="sm:col-span-1"><dt class="text-sm font-medium text-gray-500">Owner</dt><dd class="mt-1 text-sm text-gray-900">${sbData.owner_name}</dd></div>
              <div class="sm:col-span-1"><dt class="text-sm font-medium text-gray-500">Email</dt><dd class="mt-1 text-sm text-gray-900">${sbData.email}</dd></div>
              
              <div class="sm:col-span-1"><dt class="text-sm font-medium text-gray-500">Category</dt><dd class="mt-1 text-sm text-gray-900">${sbData.category}</dd></div>
              <div class="sm:col-span-1"><dt class="text-sm font-medium text-gray-500">Charity Status</dt><dd class="mt-1 text-sm text-gray-900">${sbData.is_charity}</dd></div>

              <div class="sm:col-span-1"><dt class="text-sm font-medium text-gray-500">Power</dt><dd class="mt-1 text-sm text-gray-900">${sbData.power_required}</dd></div>
              <div class="sm:col-span-1"><dt class="text-sm font-medium text-gray-500">Resident</dt><dd class="mt-1 text-sm text-gray-900">${boolYesNo(sbData.is_resident)}</dd></div>

              <div class="sm:col-span-2"><dt class="text-sm font-medium text-gray-500">Description</dt><dd class="mt-1 text-sm text-gray-900">${sbData.description}</dd></div>
              
              ${sbData.other_requirements ? `<div class="sm:col-span-2"><dt class="text-sm font-medium text-gray-500">Other Requirements</dt><dd class="mt-1 text-sm text-gray-900">${sbData.other_requirements}</dd></div>` : ''}
              
              <div class="sm:col-span-2"><dt class="text-sm font-medium text-gray-500">Files</dt><dd class="mt-1 text-sm text-gray-900">${sbData.documents ? 'Insurance Certification Uploaded' : 'None'}</dd></div>
          `;

                document.getElementById('success-ref').innerText = newBookingId;
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
});
