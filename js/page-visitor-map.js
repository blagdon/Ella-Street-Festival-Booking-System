import { initMap, handleSearch, clearSearch, locateUser, applyFilter, toggleLegend } from './map.js';
import { initPublicPage } from '../supabase-public.js';

initPublicPage(() => {
    // Attach event listeners for map controls
    document.getElementById('search-input')?.addEventListener('input', (e) => handleSearch(e.target.value));
    document.getElementById('clear-search')?.addEventListener('click', clearSearch);
    document.getElementById('filter-select')?.addEventListener('change', (e) => applyFilter(e.target.value));
    document.getElementById('btn-locate-user')?.addEventListener('click', locateUser);
    document.getElementById('btn-legend-toggle')?.addEventListener('click', toggleLegend);

    // initPublicPage has already awaited loadPublicSettings(), so the
    // DB-configured map center/zoom is applied before the map renders.
    initMap();
});

