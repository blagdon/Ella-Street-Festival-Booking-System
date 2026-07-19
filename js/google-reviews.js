/**
 * google-reviews.js
 * Google Maps reviews lookup for the booking detail pane (via the
 * get-reviews Edge Function). Extracted verbatim from js/shared.js —
 * populateDetailPane() there is still the only caller. Shares the
 * food-stall predicate and rating-bubble renderer with fsa-ratings.js.
 */
import { getSupabaseClient } from './supabase.js';
import { escapeHtml } from './utils.js';
import { isFoodStallBooking, renderRatingBubbles } from './fsa-ratings.js';

export function populateGoogleMapsReviews(item) {
    const taContainer = document.getElementById('ta-reviews-container');
    const taSearchBtn = document.getElementById('btn-ta-search');
    const taStatus = document.getElementById('ta-status');
    const taResults = document.getElementById('ta-results');

    if (!taContainer) return;

    if (isFoodStallBooking(item)) {
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
            taSearchBtn.innerText = "Search Google Maps";
            taSearchBtn.disabled = false;

            // forceRefresh=true (the explicit Refresh button) bypasses the
            // server-side SerpApi cache; the automatic on-pane-open search
            // never does — that's the call volume the cache exists to absorb.
            const runAutoTaSearch = async (forceRefresh = false) => {
                const bizName = taSearchBtn.dataset.business;
                if (!bizName || bizName.trim() === '') {
                    if (taStatus) taStatus.innerText = "Missing business name for search.";
                    return;
                }

                taSearchBtn.disabled = true;
                taSearchBtn.innerText = "Searching...";
                if (taStatus) {
                    taStatus.innerText = `Searching Google Maps for "${bizName}"...`;
                    taStatus.classList.remove('hidden');
                }
                if (taResults) taResults.classList.add('hidden');

                try {
                    const sbClient = getSupabaseClient();
                    const { data, error } = await sbClient.functions.invoke('get-reviews', {
                        body: { business_name: bizName, force: forceRefresh === true }
                    });

                    if (error) throw error;
                    if (data && data.error) throw new Error(data.error);

                    if (taStatus) taStatus.classList.add('hidden');

                    if (taResults) {
                        taResults.innerHTML = '';
                        if (data && data.found) {
                            let resultsHtml = '';

                            const ratingVal = data.rating;
                            const ratingBubbles = renderRatingBubbles(ratingVal);

                            resultsHtml += `
                                <div class="p-3 bg-white border border-gray-200 rounded-lg shadow-sm space-y-2">
                                    <div class="flex items-start gap-3">
                                        ${data.thumbnail ? `<img src="${escapeHtml(data.thumbnail)}" alt="${escapeHtml(data.title)}" class="w-12 h-12 object-cover rounded-lg border border-gray-100 shrink-0">` : ''}
                                        <div class="flex-1 min-w-0">
                                            <div class="font-bold text-gray-900 text-sm truncate">${escapeHtml(data.title)}</div>
                                            <div class="text-gray-500 text-[11px] truncate">${escapeHtml(data.location || 'Unknown Location')}</div>
                                            <div class="flex items-center gap-2 mt-1">
                                                <div class="flex">${ratingBubbles}</div>
                                                <span class="text-[10px] text-gray-400 font-medium">(${data.reviewsCount || 0} reviews)</span>
                                            </div>
                                        </div>
                                    </div>
                            `;

                            if (data.reviews && data.reviews.length > 0) {
                                resultsHtml += `
                                    <div class="mt-3 pt-3 border-t border-gray-100 space-y-3">
                                        <div class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Recent Reviews</div>
                                `;

                                resultsHtml += data.reviews.map(rev => {
                                    const revBubbles = renderRatingBubbles(rev.rating);
                                    const revDate = rev.date || 'Recent';
                                    return `
                                        <div class="space-y-1 text-[11px]">
                                            <div class="flex justify-between items-center gap-2">
                                                <span class="font-bold text-gray-800 line-clamp-1">${escapeHtml(rev.title)}</span>
                                                <span class="text-[9px] text-gray-400 shrink-0">${escapeHtml(revDate)}</span>
                                            </div>
                                            <div class="flex items-center gap-1">${revBubbles}</div>
                                            <p class="text-gray-600 line-clamp-3 italic">"${escapeHtml(rev.comment)}"</p>
                                        </div>
                                    `;
                                }).join('<hr class="border-gray-100 my-2">');

                                resultsHtml += `</div>`;
                            } else {
                                resultsHtml += `
                                    <div class="text-[10px] text-gray-400 italic mt-2 border-t border-gray-100 pt-2 text-center">
                                        No review text available.
                                    </div>
                                `;
                            }

                            resultsHtml += `</div>`;
                            taResults.innerHTML = resultsHtml;
                            taResults.classList.remove('hidden');
                            if (data.cached && taStatus) {
                                const cachedWhen = data.cached_at ? new Date(data.cached_at).toLocaleString() : '';
                                taStatus.innerText = `Cached result${cachedWhen ? ` from ${cachedWhen}` : ''} — Refresh for a live lookup.`;
                                taStatus.classList.remove('hidden');
                            }
                        } else {
                            if (taStatus) {
                                taStatus.innerText = (data.message || "No Google Maps listing found.")
                                    + (data.cached ? " (cached — Refresh for a live lookup)" : "");
                                taStatus.classList.remove('hidden');
                            }
                        }
                    }
                } catch (err) {
                    console.error("Google Maps lookup error:", err);
                    if (taStatus) {
                        taStatus.innerText = err.message || "Failed to fetch Google Maps reviews.";
                        taStatus.classList.remove('hidden');
                    }
                } finally {
                    taSearchBtn.disabled = false;
                    taSearchBtn.innerText = "Refresh Google Maps";
                }
            };

            if (!taSearchBtn.dataset.listenerBound) {
                taSearchBtn.dataset.listenerBound = 'true';
                taSearchBtn.addEventListener('click', () => runAutoTaSearch(true));
            }

            runAutoTaSearch();
        }
    } else {
        taContainer.classList.add('hidden');
    }
}
