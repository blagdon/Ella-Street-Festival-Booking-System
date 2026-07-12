import { getSupabaseClient } from './supabase.js';
import { updateBookingStatus, finalizeConfirmation, sendEmail, auditLog } from './api.js';
import { showToast } from './ui.js';
import { escapeHtml } from './utils.js';
import { getStallCost, CONFIG } from './config.js';

/**
 * Manually resends a confirmation email to a trader.
 */
export async function manualResendConfirmation(id) {
    try {
        const sb = getSupabaseClient();
        // 1. Fetch current booking data
        const { data: booking, error: fetchErr } = await sb
            .from('bookings')
            .select('*')
            .eq('id', id)
            .single();

        if (fetchErr || !booking) throw new Error("Could not find booking data.");

        // 2. Determine template
        // Check if there is a payment record to see if it's chargeable
        const { data: payData } = await sb.from('payments').select('booking_id').eq('booking_id', id).maybeSingle();
        const chargeable = !!payData;

        const templateId = chargeable ? 'confirmed_chargeable' : 'confirmed_free';

        // 3. Generate content
        const { subject, body } = await getEmailFromTemplate(templateId, booking, id);

        // 4. Queue Email
        await sendEmail(id, subject, body);

        // 5. Audit Log
        await auditLog('resend_confirmation', id, { template: templateId });

        showToast("Confirmation email resent!");
    } catch (err) {
        showToast("Failed to resend: " + err.message, 'error');
    }
}

/**
 * Manually sends a payment reminder.
 */
export async function manualSendPaymentReminder(id) {
    try {
        const sb = getSupabaseClient();
        const { data: booking, error: fetchErr } = await sb
            .from('bookings')
            .select('*')
            .eq('id', id)
            .single();

        if (fetchErr || !booking) throw new Error("Could not find booking data.");

        // 2. Determine template
        const { subject, body } = await getEmailFromTemplate('payment_reminder', booking, id);

        // 3. Queue Email
        await sendEmail(id, subject, body);

        // 4. Audit Log
        await auditLog('send_payment_reminder', id);

        showToast("Payment reminder sent!");
    } catch (err) {
        showToast("Failed to send reminder: " + err.message, 'error');
    }
}

/**
 * Fetches an email template from the database and replaces placeholders.
 */
export async function getEmailFromTemplate(templateId, booking, id, extraVars = {}) {
    const sb = getSupabaseClient();

    const { data, error } = await sb.from('email_templates')
        .select('subject, body_html')
        .eq('id', templateId)
        .single();

    if (error || !data) {
        console.error("Template error:", error);
        throw new Error(`Could not find template '${templateId}' in database.`);
    }

    let subject = data.subject;
    let body = data.body_html;

    const ownerName = escapeHtml(booking.owner_name || booking.owner || 'Trader');
    const bizName = escapeHtml(booking.business_name || booking.business || 'your business');

    // Cost calculation logic safely duplicated or imported
    let costStr = "the agreed fee";
    if (booking.stall_cost !== undefined && booking.stall_cost !== null) {
        costStr = `£${parseFloat(booking.stall_cost).toFixed(2)}`;
    } else {
        const prefix = booking.instance_prefix || CONFIG.INSTANCE_MAP['DEV'];
        costStr = `£${getStallCost(prefix).toFixed(2)}`;
    }

    let cancelToken = booking.cancel_token || '';

    // If token is missing from the in-memory snapshot, fetch it fresh from the DB
    if (!cancelToken && id) {
        try {
            const { data: tokenData } = await sb.from('bookings')
                .select('cancel_token')
                .eq('id', id)
                .single();
            if (tokenData && tokenData.cancel_token) {
                cancelToken = tokenData.cancel_token;
            }
        } catch (e) {
            console.warn('Could not fetch cancel_token:', e);
        }
    }

    const cancelBase = CONFIG.URLS.CANCEL_URL;
    if (!cancelBase) {
        console.warn('CONFIG.URLS.CANCEL_URL is not set — check the cancel_url row in the settings table / supabase-public.js.');
    }
    const cancelLink = (cancelToken && cancelBase)
        ? `${cancelBase}?token=${encodeURIComponent(cancelToken)}`
        : (cancelBase || '');
    const bankDetails = CONFIG.BANK_DETAILS;
    const locationId = escapeHtml(booking.location_id || 'TBA');
    const reason = escapeHtml(extraVars.reason || 'Oversubscribed / Category Full');

    const replaceVars = (str) => {
        return str
            .replace(/\{\{owner_name\}\}/g, ownerName)
            .replace(/\{\{business_name\}\}/g, bizName)
            .replace(/\{\{booking_id\}\}/g, id)
            .replace(/\{\{cancel_link\}\}/g, cancelLink)
            .replace(/\{\{cost\}\}/g, costStr)
            .replace(/\{\{bank_details\}\}/g, bankDetails)
            .replace(/\{\{location_id\}\}/g, locationId)
            .replace(/\{\{reason\}\}/g, reason);
    };

    return {
        subject: replaceVars(subject),
        body: replaceVars(body)
    };
}

/**
 * Queues a location allocation email using a database template.
 * @param {string} id 
 */
export async function queueLocationEmail(id) {
    const sb = getSupabaseClient();

    // 1. Fetch booking data
    const { data: booking, error: fErr } = await sb
        .from('bookings')
        .select('email, owner_name, business_name, location_id, instance_prefix, cancel_token')
        .eq('id', id)
        .single();

    if (fErr || !booking) throw new Error("Could not find booking data: " + (fErr?.message || "Not found"));
    if (!booking.location_id) throw new Error("No location assigned yet.");

    // 2. Generate content from template
    const { subject, body } = await getEmailFromTemplate('location_update', booking, id);

    // 3. Queue via API
    await sendEmail(id, subject, body);

    // 4. Audit Log
    await auditLog('location_email_queued', id, { location_id: booking.location_id });
}

/**
 * Shared logic to update a booking status.
 */
export async function sharedUpdateStatus(id, status, allBookings, options = {}) {
    const { reason = null, isChargeable = null, overrideCost = null, onSuccess, onError } = options;

    try {
        // 1. Update DB Status
        await updateBookingStatus(id, status, reason);

        // 2. Handle Confirmation specific logic
        if (status === 'Confirmed') {
            const chargeable = (isChargeable === null) ? true : isChargeable;

            // A. Finalize Payments
            const booking = allBookings.find(b => b.id === id);
            await finalizeConfirmation(id, chargeable, booking, overrideCost);

            // B. Auto-send Confirmation Email
            if (booking) {
                const templateId = chargeable ? 'confirmed_chargeable' : 'confirmed_free';
                const { subject, body } = await getEmailFromTemplate(templateId, booking, id);
                await sendEmail(id, subject, body);
                showToast('Booking confirmed and email queued');
            } else {
                showToast('Booking confirmed');
            }
        } else if (status === 'Rejected') {
            const booking = allBookings.find(b => b.id === id);
            if (booking) {
                const { subject, body } = await getEmailFromTemplate('rejected', booking, id, { reason: reason });
                await sendEmail(id, subject, body);
                showToast('Booking rejected and email queued', 'info');
            } else {
                showToast('Booking rejected', 'info');
            }
        } else {
            showToast(`Booking moved to ${status}`);
        }

        // 3. Update Local Cache
        const b = allBookings.find(i => i.id === id);
        if (b) b.status = status;

        // 4. Update Detail Pane status badge if open uses DOM calls, we can implement updateDetailStatusBadge here or specific UI file
        // For now, assuming dom element update is handled by the caller or we can export a helper
        // We will leave the DOM updates to the page logic or a separate UI helper mostly

        if (onSuccess) onSuccess(status);

    } catch (err) {
        showToast("Failed to update: " + err.message, 'error');
        if (onError) onError();
    }
}

/**
 * Populates the detail pane with booking data.
 */
export function populateDetailPane(item) {
    const setTxt = (eid, val) => {
        const el = document.getElementById(eid);
        if (el) el.innerText = val || "--";
    };

    setTxt('d-id', item.id);
    setTxt('d-business', item.business || item.business_name);

    const regBusinessEl = document.getElementById('d-registered-business');
    const regBusinessContainer = document.getElementById('registered-business-container');
    if (regBusinessEl && regBusinessContainer) {
        const regName = item.registered_business_name || '';
        if (regName && regName !== '--' && regName.trim() !== '') {
            regBusinessEl.innerText = regName;
            regBusinessContainer.classList.remove('hidden');
        } else {
            regBusinessEl.innerText = '--';
            regBusinessContainer.classList.add('hidden');
        }
    }

    setTxt('d-owner', item.owner || item.owner_name);
    setTxt('d-email', item.email);
    setTxt('d-phone', item.phone || "Not provided");
    setTxt('d-address', item.house || item.address || "N/A");
    setTxt('d-category', item.category);
    setTxt('d-stalltype', item.stall_type);

    const powerEl = document.getElementById('d-power');
    if (powerEl) {
        const power = item.power_required || item.power || 'No power';
        powerEl.innerText = power;
    }

    setTxt('d-desc', item.description || "No description provided.");

    const resEl = document.getElementById('d-resident');
    if (resEl) {
        const isRes = item.is_resident === true;
        resEl.innerText = isRes ? 'Yes' : 'No';
        resEl.className = isRes
            ? "inline-block text-xs font-bold px-2 py-1 rounded bg-blue-100 text-blue-700"
            : "inline-block text-xs font-bold px-2 py-1 rounded bg-gray-100 text-gray-500";
    }

    const charEl = document.getElementById('d-charity');
    if (charEl) {
        const charityStatus = item.is_charity || 'Commercial';
        charEl.innerText = charityStatus;

        if (charityStatus === 'Charity') {
            charEl.className = "inline-block text-xs font-bold px-2 py-1 rounded bg-green-100 text-green-700";
        } else if (charityStatus === 'Not for profit') {
            charEl.className = "inline-block text-xs font-bold px-2 py-1 rounded bg-blue-100 text-blue-700";
        } else {
            charEl.className = "inline-block text-xs font-bold px-2 py-1 rounded bg-gray-100 text-gray-500";
        }
    }

    const locEl = document.getElementById('d-location');
    if (locEl) {
        locEl.innerText = item.location_id || "Unassigned";
        locEl.className = item.location_id
            ? "text-sm font-mono bg-blue-100 px-1 rounded text-blue-800"
            : "text-sm font-mono bg-yellow-100 px-1 rounded text-yellow-800";
    }

    const statusBadge = document.getElementById('d-status-badge');
    if (statusBadge) {
        statusBadge.innerText = item.status;
        let sClass = "bg-gray-100 text-gray-800";
        // Map status colors if necessary, or rely on Tailwind classes update
        if (item.status === 'Confirmed') sClass = "bg-green-100 text-green-800";
        else if (item.status === 'Rejected') sClass = "bg-red-100 text-red-800";
        else if (item.status === 'Pending') sClass = "bg-yellow-100 text-yellow-800";

        statusBadge.className = `inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${sClass}`;
    }

    // Show rejection reason banner only for rejected bookings
    const rejContainer = document.getElementById('d-rejection-container');
    const rejReason = document.getElementById('d-rejection-reason');
    if (rejContainer && rejReason) {
        if (item.status === 'Rejected' && item.rejection_reason) {
            rejReason.innerText = item.rejection_reason;
            rejContainer.classList.remove('hidden');
        } else {
            rejContainer.classList.add('hidden');
            rejReason.innerText = '';
        }
    }

    const docsEl = document.getElementById('d-docs');
    if (docsEl) {
        docsEl.innerHTML = '';
        const rawDocs = item.documents;

        if (!rawDocs || rawDocs === "None") {
            docsEl.innerText = "None";
        } else {
            let docArray = [];
            if (Array.isArray(rawDocs)) {
                docArray = rawDocs;
            } else if (typeof rawDocs === 'string') {
                docArray = rawDocs.split(/[\n,]+/).map(p => p.trim()).filter(p => p);
            }

            if (docArray.length === 0) {
                docsEl.innerText = "None";
            } else {
                let html = '';
                docArray.forEach((part, index) => {
                    // Simple URL check
                    let safeUrl = null;
                    try { safeUrl = new URL(part).href; } catch (e) { }

                    if (safeUrl) {
                        html += `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="flex items-center text-blue-600 hover:text-blue-800 hover:underline mb-1 font-medium bg-blue-50 p-2 rounded border border-blue-100">
                            <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
                            Open Document ${docArray.length > 1 ? index + 1 : ''}
                        </a>`;
                    } else {
                        html += `<div class="mb-1 text-gray-600 text-xs bg-gray-50 p-1 rounded break-words">${escapeHtml(part)}</div>`;
                    }
                });
                docsEl.innerHTML = html;
            }
        }
    }

    const checkEl = document.getElementById('d-checklist');
    if (checkEl) {
        checkEl.innerText = item.docs_checklist || "No checklist data";
    }

    const otherEl = document.getElementById('d-other');
    if (otherEl) {
        otherEl.innerText = item.other_requirements || item.other || "None";
    }

    const notesEl = document.getElementById('d-notes');
    if (notesEl) {
        notesEl.value = item.admin_notes || item.notes || "";
    }

    // --- FSA FOOD HYGIENE RATINGS FOR FOOD STALLS ---
    const fsaContainer = document.getElementById('fsa-ratings-container');
    const fsaSearchBtn = document.getElementById('btn-fsa-search');
    const fsaStatus = document.getElementById('fsa-status');
    const fsaResults = document.getElementById('fsa-results');

    if (fsaContainer) {
        const isFoodStall = (item.id && item.id.includes('-FOOD-')) || 
                            (item.category && (
                                item.category.toLowerCase().includes('food') || 
                                item.category.toLowerCase().includes('catering') || 
                                item.category.toLowerCase().includes('alcohol')
                            )) ||
                            (localStorage.getItem('ESF_INSTANCE') === 'FOOD');

        if (isFoodStall) {
            fsaContainer.classList.remove('hidden');
            if (fsaStatus) {
                fsaStatus.innerText = "Ready to search.";
                fsaStatus.classList.remove('hidden');
            }
            if (fsaResults) {
                fsaResults.innerHTML = '';
                fsaResults.classList.add('hidden');
            }
            if (fsaSearchBtn) {
                fsaSearchBtn.dataset.business = item.business || item.business_name || '';
                fsaSearchBtn.dataset.registered = item.registered_business_name || '';
                fsaSearchBtn.dataset.address = item.address || '';
                fsaSearchBtn.innerText = "Search FHRS Database";
                fsaSearchBtn.disabled = false;

                // Define search logic
                const runAutoFsaSearch = async () => {
                    const bizName = fsaSearchBtn.dataset.business;
                    const regName = fsaSearchBtn.dataset.registered;
                    const bizAddr = fsaSearchBtn.dataset.address;

                    fsaSearchBtn.disabled = true;
                    fsaSearchBtn.innerText = "Searching...";
                    if (fsaStatus) {
                        fsaStatus.innerText = `Searching FSA database...`;
                        fsaStatus.classList.remove('hidden');
                    }
                    if (fsaResults) fsaResults.classList.add('hidden');

                    try {
                        const postcode = extractPostcode(bizAddr);
                        let establishments = [];
                        let isMobileCaterer = true;

                        // --- STAGE 1: Search as Mobile Caterer (businessTypeId = 7846) ---
                        // Tier 1: Trading name + postcode (Mobile)
                        if (postcode) {
                            if (fsaStatus) fsaStatus.innerText = `Searching for "${bizName}" (Mobile Caterer) in ${postcode}...`;
                            establishments = await fetchFsaEstablishments(bizName, postcode, 7846);
                            if (establishments.length > 0 && !hasNameMatch(establishments, bizName, regName)) {
                                establishments = [];
                            }
                        }

                        // Tier 2: Registered name + postcode (Mobile)
                        if ((!establishments || establishments.length === 0) && postcode && regName && regName !== '--' && regName.trim() !== '') {
                            if (fsaStatus) fsaStatus.innerText = `Searching for "${regName}" (Mobile Caterer) in ${postcode}...`;
                            establishments = await fetchFsaEstablishments(regName, postcode, 7846);
                            if (establishments.length > 0 && !hasNameMatch(establishments, bizName, regName)) {
                                establishments = [];
                            }
                        }

                        // Tier 3: Trading name + full address (Mobile)
                        if (!establishments || establishments.length === 0) {
                            if (fsaStatus) fsaStatus.innerText = `Searching for "${bizName}" (Mobile Caterer) with address...`;
                            establishments = await fetchFsaEstablishments(bizName, bizAddr, 7846);
                            if (establishments.length > 0 && !hasNameMatch(establishments, bizName, regName)) {
                                establishments = [];
                            }
                        }

                        // Tier 4: Registered name + full address (Mobile)
                        if ((!establishments || establishments.length === 0) && regName && regName !== '--' && regName.trim() !== '') {
                            if (fsaStatus) fsaStatus.innerText = `Searching for "${regName}" (Mobile Caterer) with address...`;
                            establishments = await fetchFsaEstablishments(regName, bizAddr, 7846);
                            if (establishments.length > 0 && !hasNameMatch(establishments, bizName, regName)) {
                                establishments = [];
                            }
                        }

                        // Tier 5: Trading name alone (Mobile)
                        if (!establishments || establishments.length === 0) {
                            if (fsaStatus) fsaStatus.innerText = `Searching for "${bizName}" (Mobile Caterer) alone...`;
                            establishments = await fetchFsaEstablishments(bizName, null, 7846);
                            if (establishments.length > 0 && !hasNameMatch(establishments, bizName, regName)) {
                                establishments = [];
                            }
                        }

                        // Tier 6: Registered name alone (Mobile)
                        if ((!establishments || establishments.length === 0) && regName && regName !== '--' && regName.trim() !== '') {
                            if (fsaStatus) fsaStatus.innerText = `Searching for "${regName}" (Mobile Caterer) alone...`;
                            establishments = await fetchFsaEstablishments(regName, null, 7846);
                            if (establishments.length > 0 && !hasNameMatch(establishments, bizName, regName)) {
                                establishments = [];
                            }
                        }

                        // --- STAGE 2: Fallback to all business types if no mobile records found ---
                        if (!establishments || establishments.length === 0) {
                            isMobileCaterer = false;

                            // Tier 1: Trading name + postcode (All)
                            if (postcode) {
                                if (fsaStatus) fsaStatus.innerText = `No mobile record. Searching all types for "${bizName}" in ${postcode}...`;
                                establishments = await fetchFsaEstablishments(bizName, postcode);
                                if (establishments.length > 0 && !hasNameMatch(establishments, bizName, regName)) {
                                    establishments = [];
                                }
                            }

                            // Tier 2: Registered name + postcode (All)
                            if ((!establishments || establishments.length === 0) && postcode && regName && regName !== '--' && regName.trim() !== '') {
                                if (fsaStatus) fsaStatus.innerText = `No mobile record. Searching all types for "${regName}" in ${postcode}...`;
                                establishments = await fetchFsaEstablishments(regName, postcode);
                                if (establishments.length > 0 && !hasNameMatch(establishments, bizName, regName)) {
                                    establishments = [];
                                }
                            }

                            // Tier 3: Trading name + full address (All)
                            if (!establishments || establishments.length === 0) {
                                if (fsaStatus) fsaStatus.innerText = `No mobile record. Searching all types for "${bizName}" with address...`;
                                establishments = await fetchFsaEstablishments(bizName, bizAddr);
                                if (establishments.length > 0 && !hasNameMatch(establishments, bizName, regName)) {
                                    establishments = [];
                                }
                            }

                            // Tier 4: Registered name + full address (All)
                            if ((!establishments || establishments.length === 0) && regName && regName !== '--' && regName.trim() !== '') {
                                if (fsaStatus) fsaStatus.innerText = `No mobile record. Searching all types for "${regName}" with address...`;
                                establishments = await fetchFsaEstablishments(regName, bizAddr);
                                if (establishments.length > 0 && !hasNameMatch(establishments, bizName, regName)) {
                                    establishments = [];
                                }
                            }

                            // Tier 5: Trading name alone (All)
                            if (!establishments || establishments.length === 0) {
                                if (fsaStatus) fsaStatus.innerText = `No mobile record. Searching all types for "${bizName}" alone...`;
                                establishments = await fetchFsaEstablishments(bizName);
                                if (establishments.length > 0 && !hasNameMatch(establishments, bizName, regName)) {
                                    establishments = [];
                                }
                            }

                            // Tier 6: Registered name alone (All)
                            if ((!establishments || establishments.length === 0) && regName && regName !== '--' && regName.trim() !== '') {
                                if (fsaStatus) fsaStatus.innerText = `No mobile record. Searching all types for "${regName}" alone...`;
                                establishments = await fetchFsaEstablishments(regName);
                                if (establishments.length > 0 && !hasNameMatch(establishments, bizName, regName)) {
                                    establishments = [];
                                }
                            }
                        }

                        if (fsaStatus) fsaStatus.classList.add('hidden');

                        if (fsaResults) {
                            fsaResults.innerHTML = '';
                            if (establishments && establishments.length > 0) {
                                let resultsHtml = '';
                                if (!isMobileCaterer) {
                                    resultsHtml += `
                                        <div class="p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-[11px] text-amber-800 flex items-start gap-1.5 mb-2">
                                            <svg class="h-4 w-4 text-amber-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                                                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                                            </svg>
                                            <div>
                                                <span class="font-bold">No mobile caterer record found.</span> Showing matching records from other business types.
                                            </div>
                                        </div>
                                    `;
                                }
                                resultsHtml += establishments.map(est => {
                                    const address = [est.AddressLine1, est.AddressLine2, est.AddressLine3, est.PostCode].filter(Boolean).join(', ');
                                    const ratingDate = est.RatingDate ? new Date(est.RatingDate).toLocaleDateString('en-GB') : 'Unknown';
                                    
                                    // Color code rating badge
                                    const ratingVal = est.RatingValue;
                                    let ratingColor = "bg-gray-100 text-gray-800";
                                    if (ratingVal === "5") ratingColor = "bg-green-100 text-green-800 border border-green-300 font-bold";
                                    else if (ratingVal === "4" || ratingVal === "3") ratingColor = "bg-yellow-100 text-yellow-800 border border-yellow-300 font-bold";
                                    else if (ratingVal === "2" || ratingVal === "1" || ratingVal === "0") ratingColor = "bg-red-100 text-red-800 border border-red-300 font-bold animate-pulse";
                                    else if (ratingVal && ratingVal.toLowerCase().includes('exempt')) ratingColor = "bg-blue-100 text-blue-800 border border-blue-300";

                                    return `
                                        <div class="p-3 bg-white border border-gray-200 rounded-lg shadow-sm space-y-1.5 text-xs text-gray-700">
                                            <div class="flex justify-between items-start gap-2">
                                                <span class="font-bold text-gray-900">${escapeHtml(est.BusinessName)}</span>
                                                <span class="px-2 py-0.5 rounded text-[10px] ${ratingColor}">${ratingVal || 'N/A'}</span>
                                            </div>
                                            <div class="text-gray-500">${escapeHtml(address)}</div>
                                            <div class="text-gray-400 text-[10px] italic">Type: ${escapeHtml(est.BusinessType || 'Unknown')}</div>
                                            <div class="flex justify-between items-center text-[10px] text-gray-400 pt-1 border-t border-gray-100">
                                                <span>Authority: ${escapeHtml(est.LocalAuthorityName)}</span>
                                                <span>Date: ${escapeHtml(ratingDate)}</span>
                                            </div>
                                        </div>
                                    `;
                                }).join('');
                                fsaResults.innerHTML = resultsHtml;
                                fsaResults.classList.remove('hidden');
                            } else {
                                if (fsaStatus) {
                                    fsaStatus.innerText = "No matching food hygiene ratings found.";
                                    fsaStatus.classList.remove('hidden');
                                }
                            }
                        }
                    } catch (err) {
                        console.error("FSA lookup error:", err);
                        if (fsaStatus) {
                            fsaStatus.innerText = "Failed to fetch ratings from FSA.";
                            fsaStatus.classList.remove('hidden');
                        }
                    } finally {
                        fsaSearchBtn.disabled = false;
                        fsaSearchBtn.innerText = "Refresh Ratings";
                    }
                };

                // Bind click handler once for manual refresh
                if (!fsaSearchBtn.dataset.listenerBound) {
                    fsaSearchBtn.dataset.listenerBound = 'true';
                    fsaSearchBtn.addEventListener('click', runAutoFsaSearch);
                }

                // Automatically trigger search when pane is populated
                runAutoFsaSearch();
            }
        } else {
            fsaContainer.classList.add('hidden');
        }
    }

    // --- TRIPADVISOR REVIEWS FOR FOOD STALLS ---
    const taContainer = document.getElementById('ta-reviews-container');
    const taSearchBtn = document.getElementById('btn-ta-search');
    const taStatus = document.getElementById('ta-status');
    const taResults = document.getElementById('ta-results');

    if (taContainer) {
        const isFoodStall = (item.id && item.id.includes('-FOOD-')) || 
                            (item.category && (
                                item.category.toLowerCase().includes('food') || 
                                item.category.toLowerCase().includes('catering') || 
                                item.category.toLowerCase().includes('alcohol')
                            )) ||
                            (localStorage.getItem('ESF_INSTANCE') === 'FOOD');

        if (isFoodStall) {
            taContainer.classList.remove('hidden');
            if (taStatus) {
                taStatus.innerText = "Ready to search.";
                taStatus.classList.remove('hidden');
            }
            if (taResults) {
                taResults.innerHTML = '';
                taResults.classList.add('hidden');
            }
            if (taSearchBtn) {
                taSearchBtn.dataset.business = item.business || item.business_name || '';
                taSearchBtn.innerText = "Search TripAdvisor";
                taSearchBtn.disabled = false;

                const runAutoTaSearch = async () => {
                    const bizName = taSearchBtn.dataset.business;
                    if (!bizName || bizName.trim() === '') {
                        if (taStatus) taStatus.innerText = "Missing business name for search.";
                        return;
                    }

                    taSearchBtn.disabled = true;
                    taSearchBtn.innerText = "Searching...";
                    if (taStatus) {
                        taStatus.innerText = `Searching TripAdvisor for "${bizName}"...`;
                        taStatus.classList.remove('hidden');
                    }
                    if (taResults) taResults.classList.add('hidden');

                    try {
                        const sbClient = getSupabaseClient();
                        const { data, error } = await sbClient.functions.invoke('get-reviews', {
                            body: { business_name: bizName }
                        });

                        if (error) throw error;
                        if (data && data.error) throw new Error(data.error);

                        if (taStatus) taStatus.classList.add('hidden');

                        if (taResults) {
                            taResults.innerHTML = '';
                            if (data && data.found) {
                                // Compute average rating from reviews if top-level rating is null
                                let displayRating = data.rating;
                                if (!displayRating && data.reviews && data.reviews.length > 0) {
                                    const ratingsWithValues = data.reviews.filter(r => r.rating);
                                    if (ratingsWithValues.length > 0) {
                                        displayRating = ratingsWithValues.reduce((sum, r) => sum + r.rating, 0) / ratingsWithValues.length;
                                    }
                                }

                                const ratingBubbles = renderRatingBubbles(displayRating);
                                const taLink = data.ta_url ? ` <a href="${escapeHtml(data.ta_url)}" target="_blank" rel="noopener" style="font-size:9px;color:#00aa6c;text-decoration:none;margin-left:4px;">View on TripAdvisor ↗</a>` : '';

                                let resultsHtml = `
                                    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:10px;margin-top:6px;">
                                        <div style="display:flex;align-items:flex-start;gap:10px;">
                                            ${data.thumbnail ? `<img src="${escapeHtml(data.thumbnail)}" alt="${escapeHtml(data.title)}" style="width:40px;height:40px;object-fit:cover;border-radius:6px;border:1px solid #f3f4f6;flex-shrink:0;">` : ''}
                                            <div style="flex:1;min-width:0;">
                                                <div style="font-weight:700;font-size:12px;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(data.title)}${taLink}</div>
                                                <div style="font-size:10px;color:#6b7280;margin-top:2px;">Hull, UK</div>
                                                <div style="display:flex;align-items:center;gap:6px;margin-top:4px;">
                                                    <div>${ratingBubbles}</div>
                                                    <span style="font-size:10px;color:#9ca3af;">${displayRating ? displayRating.toFixed(1) + ' / 5' : 'Rating not available'}</span>
                                                </div>
                                            </div>
                                        </div>
                                `;

                                // Render individual reviews (if any)
                                if (data.reviews && data.reviews.length > 0) {
                                    resultsHtml += `
                                        <div style="margin-top:10px;padding-top:10px;border-top:1px solid #f3f4f6;">
                                            <div style="font-size:9px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Recent Reviews</div>
                                    `;

                                    resultsHtml += data.reviews.map(rev => {
                                        const revBubbles = renderRatingBubbles(rev.rating);
                                        const revDate = rev.date ? new Date(rev.date).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : 'Recent';
                                        const revLink = rev.link ? ` href="${escapeHtml(rev.link)}" target="_blank" rel="noopener"` : '';
                                        return `
                                            <div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #f9fafb;">
                                                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:3px;">
                                                    <a${revLink} style="font-weight:600;font-size:11px;color:#1f2937;text-decoration:none;line-height:1.3;">${escapeHtml(rev.title)}</a>
                                                    <span style="font-size:9px;color:#9ca3af;white-space:nowrap;">${escapeHtml(revDate)}</span>
                                                </div>
                                                <div style="display:flex;align-items:center;gap:4px;margin-bottom:4px;">${revBubbles}${rev.author ? `<span style="font-size:9px;color:#9ca3af;"> — ${escapeHtml(rev.author)}</span>` : ''}</div>
                                                <p style="font-size:11px;color:#4b5563;font-style:italic;line-height:1.5;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;">"${escapeHtml(rev.comment)}"</p>
                                            </div>
                                        `;
                                    }).join('');

                                    resultsHtml += `</div>`;
                                } else {
                                    resultsHtml += `
                                        <div style="font-size:10px;color:#9ca3af;font-style:italic;margin-top:8px;padding-top:8px;border-top:1px solid #f3f4f6;text-align:center;">
                                            No review text available.
                                        </div>
                                    `;
                                }

                                resultsHtml += `</div>`;
                                taResults.innerHTML = resultsHtml;
                                taResults.classList.remove('hidden');
                            } else {
                                if (taStatus) {
                                    taStatus.innerText = data.message || "No TripAdvisor listing found.";
                                    taStatus.classList.remove('hidden');
                                }
                            }
                        }
                    } catch (err) {
                        console.error("TripAdvisor lookup error:", err);
                        if (taStatus) {
                            taStatus.innerText = err.message || "Failed to fetch TripAdvisor reviews.";
                            taStatus.classList.remove('hidden');
                        }
                    } finally {
                        taSearchBtn.disabled = false;
                        taSearchBtn.innerText = "Refresh TripAdvisor";
                    }
                };

                if (!taSearchBtn.dataset.listenerBound) {
                    taSearchBtn.dataset.listenerBound = 'true';
                    taSearchBtn.addEventListener('click', runAutoTaSearch);
                }

                runAutoTaSearch();
            }
        } else {
            taContainer.classList.add('hidden');
        }
    }
}

export function extractPostcode(address) {
    if (!address) return null;
    const postcodeRegex = /\b([A-Z]{1,2}[0-9][A-Z0-9]?)\s*([0-9][A-Z]{2})?\b/i;
    const match = address.match(postcodeRegex);
    if (match) {
        return match[1].toUpperCase();
    }
    return null;
}

export function hasNameMatch(establishments, bizName, regName) {
    const cleanBiz = (bizName || '').trim().toLowerCase();
    const cleanReg = (regName && regName !== '--') ? regName.trim().toLowerCase() : '';
    
    return establishments.some(est => {
        const estName = est.BusinessName.trim().toLowerCase();
        return (cleanBiz && (estName.includes(cleanBiz) || cleanBiz.includes(estName))) ||
               (cleanReg && (estName.includes(cleanReg) || cleanReg.includes(estName)));
    });
}

async function fetchFsaEstablishments(name, address = null, businessTypeId = null) {
    if (!name || name.trim() === '') return [];
    try {
        let url = `https://api.ratings.food.gov.uk/Establishments?name=${encodeURIComponent(name.trim())}&pageSize=5`;
        if (address && address.trim() !== '' && address !== 'N/A') {
            url += `&address=${encodeURIComponent(address.trim())}`;
        }
        if (businessTypeId) {
            url += `&businessTypeId=${businessTypeId}`;
        }
        const res = await fetch(url, {
            headers: {
                'x-api-version': '2',
                'Accept': 'application/json'
            }
        });
        if (!res.ok) return [];
        const json = await res.json();
        return json.establishments || [];
    } catch (e) {
        console.error("FSA API fetch failed:", e);
        return [];
    }
}

function renderRatingBubbles(rating) {
    const r = parseFloat(rating) || 0;
    let html = '';
    for (let i = 1; i <= 5; i++) {
        if (i <= r) {
            html += `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#00aa6c;border:1px solid #00aa6c;margin-right:2px;"></span>`;
        } else if (i - 0.5 <= r) {
            html += `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:linear-gradient(to right,#00aa6c 50%,#e5e7eb 50%);border:1px solid #d1d5db;margin-right:2px;"></span>`;
        } else {
            html += `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#f3f4f6;border:1px solid #d1d5db;margin-right:2px;"></span>`;
        }
    }
    return html;
}
