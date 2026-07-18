/**
 * fsa-ratings.js
 * FSA (Food Standards Agency) food-hygiene-rating lookup for the booking
 * detail pane, plus the food-stall predicate and rating-bubble renderer
 * shared with the Google Maps reviews section (google-reviews.js).
 * Extracted verbatim from js/shared.js — populateDetailPane() there is
 * still the only caller of populateFsaSection().
 */
import { escapeHtml } from './utils.js';

/**
 * Whether a booking should get the food-stall vetting sections (FSA
 * hygiene ratings + Google reviews) in the detail pane.
 */
export function isFoodStallBooking(item) {
    return (item.id && item.id.includes('-FOOD-')) ||
           (item.category && (
               item.category.toLowerCase().includes('food') ||
               item.category.toLowerCase().includes('catering') ||
               item.category.toLowerCase().includes('alcohol')
           )) ||
           (typeof localStorage !== 'undefined' && localStorage.getItem('ESF_INSTANCE') === 'FOOD');
}

export function populateFsaSection(item) {
    const fsaContainer = document.getElementById('fsa-ratings-container');
    const fsaSearchBtn = document.getElementById('btn-fsa-search');
    const fsaStatus = document.getElementById('fsa-status');
    const fsaResults = document.getElementById('fsa-results');

    if (!fsaContainer) return;

    if (isFoodStallBooking(item)) {
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

                    // Search strategies: Stage 1 (Mobile Caterer) then Stage 2 (All business types)
                    const stages = [
                        {
                            businessTypeId: 7846,
                            isMobile: true,
                            strategies: [
                                { query: bizName, location: postcode, desc: `for "${bizName}" (Mobile Caterer) in ${postcode || ''}` },
                                { query: regName, location: postcode, desc: `for "${regName}" (Mobile Caterer) in ${postcode || ''}` },
                                { query: bizName, location: bizAddr, desc: `for "${bizName}" (Mobile Caterer) with address` },
                                { query: regName, location: bizAddr, desc: `for "${regName}" (Mobile Caterer) with address` },
                                { query: bizName, location: null, desc: `for "${bizName}" (Mobile Caterer) alone` },
                                { query: regName, location: null, desc: `for "${regName}" (Mobile Caterer) alone` }
                            ]
                        },
                        {
                            businessTypeId: null,
                            isMobile: false,
                            strategies: [
                                { query: bizName, location: postcode, desc: `No mobile record. Searching all types for "${bizName}" in ${postcode || ''}` },
                                { query: regName, location: postcode, desc: `No mobile record. Searching all types for "${regName}" in ${postcode || ''}` },
                                { query: bizName, location: bizAddr, desc: `No mobile record. Searching all types for "${bizName}" with address` },
                                { query: regName, location: bizAddr, desc: `No mobile record. Searching all types for "${regName}" with address` },
                                { query: bizName, location: null, desc: `No mobile record. Searching all types for "${bizName}" alone` },
                                { query: regName, location: null, desc: `No mobile record. Searching all types for "${regName}" alone` }
                            ]
                        }
                    ];

                    for (const stage of stages) {
                        isMobileCaterer = stage.isMobile;
                        for (const strat of stage.strategies) {
                            if (!strat.query || strat.query === '--' || strat.query.trim() === '') continue;
                            if (strat.location === undefined || strat.location === null || strat.location.trim() === '') {
                                if (strat.location !== null) continue;
                            }

                            if (fsaStatus) fsaStatus.innerText = strat.desc;
                            establishments = await fetchFsaEstablishments(strat.query, strat.location, stage.businessTypeId);

                            if (establishments.length > 0 && hasNameMatch(establishments, bizName, regName)) {
                                break;
                            } else {
                                establishments = [];
                            }
                        }
                        if (establishments.length > 0) {
                            break;
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

            if (!fsaSearchBtn.dataset.listenerBound) {
                fsaSearchBtn.dataset.listenerBound = 'true';
                fsaSearchBtn.addEventListener('click', runAutoFsaSearch);
            }

            runAutoFsaSearch();
        }
    } else {
        fsaContainer.classList.add('hidden');
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
    // Normalize punctuation (hyphens, apostrophes) to spaces and collapse
    // repeated whitespace, since FSA listings often differ from trading
    // names only by punctuation (e.g. "Nana-Noos" vs "Nana Noos").
    const normalize = (s) => (s || '')
        .toLowerCase()
        .replace(/[-'’]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const cleanBiz = normalize(bizName);
    const cleanReg = (regName && regName !== '--') ? normalize(regName) : '';

    return establishments.some(est => {
        const estName = normalize(est.BusinessName);
        return (cleanBiz && (estName.includes(cleanBiz) || cleanBiz.includes(estName))) ||
               (cleanReg && (estName.includes(cleanReg) || cleanReg.includes(estName)));
    });
}

async function fetchFsaEstablishments(name, address = null, businessTypeId = null) {
    if (!name || name.trim() === '') return [];

    const doSearch = async (searchName) => {
        let url = `https://api.ratings.food.gov.uk/Establishments?name=${encodeURIComponent(searchName)}&pageSize=5`;
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
        // TEMP DEBUG: FSA's name search may be a literal/substring match, so
        // punctuation differences (e.g. "Nana Noos" vs "Nana-Noos") could miss
        // valid results even though the business is registered. Log the raw
        // count here to confirm before removing this.
        console.log(`FSA search "${searchName}":`, (json.establishments || []).length, 'result(s)');
        return json.establishments || [];
    };

    try {
        let results = await doSearch(name.trim());

        // Retry with spaces swapped for hyphens if the plain search found
        // nothing — FSA listings sometimes use a hyphenated form of a name
        // that a stallholder wrote with a space (or vice versa).
        const hyphenated = name.trim().replace(/\s+/g, '-');
        const dehyphenated = name.trim().replace(/-/g, ' ');
        if (results.length === 0 && hyphenated.toLowerCase() !== name.trim().toLowerCase()) {
            results = await doSearch(hyphenated);
        }
        if (results.length === 0 && dehyphenated.toLowerCase() !== name.trim().toLowerCase()) {
            results = await doSearch(dehyphenated);
        }

        return results;
    } catch (e) {
        console.error("FSA API fetch failed:", e);
        return [];
    }
}

export function renderRatingBubbles(rating, showValue = true) {
    const r = parseFloat(rating) || 0;
    let stars = '';
    for (let i = 1; i <= 5; i++) {
        if (i <= Math.round(r)) {
            stars += `<span class="text-amber-400" style="font-size:14px;line-height:1;">★</span>`;
        } else {
            stars += `<span class="text-gray-300" style="font-size:14px;line-height:1;">★</span>`;
        }
    }
    const valueHtml = (showValue && r > 0)
        ? `<span class="text-xs font-bold text-gray-700 ml-1">${r.toFixed(1)}</span>`
        : '';
    return `<span class="inline-flex items-center">${stars}${valueHtml}</span>`;
}
