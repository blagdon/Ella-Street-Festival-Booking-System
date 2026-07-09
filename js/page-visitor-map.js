import { initMap, handleSearch, clearSearch, locateUser, applyFilter } from './map.js';

document.addEventListener('DOMContentLoaded', async () => {
    try {
        // Attach event listeners for map controls
        document.getElementById('search-input-field')?.addEventListener('input', (e) => handleSearch(e.target.value));
        document.getElementById('btn-clear-search')?.addEventListener('click', clearSearch);
        document.getElementById('filter-select-field')?.addEventListener('change', (e) => applyFilter(e.target.value));
        document.getElementById('btn-locate-user')?.addEventListener('click', locateUser);

        initMap();
    } catch (e) {
        console.error(e);
    }
});

