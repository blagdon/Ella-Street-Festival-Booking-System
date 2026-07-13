import { initMap, handleSearch, clearSearch, locateUser, applyFilter } from './map.js';
import { loadPublicSettings } from '../supabase-public.js';

document.addEventListener('DOMContentLoaded', async () => {
    try {
        // Attach event listeners for map controls
        document.getElementById('search-input')?.addEventListener('input', (e) => handleSearch(e.target.value));
        document.getElementById('clear-search')?.addEventListener('click', clearSearch);
        document.getElementById('filter-select')?.addEventListener('change', (e) => applyFilter(e.target.value));
        document.getElementById('btn-locate-user')?.addEventListener('click', locateUser);

        await loadPublicSettings(); // ensure DB-configured map center/zoom is applied before the map renders
        initMap();
    } catch (e) {
        console.error(e);
    }
});

