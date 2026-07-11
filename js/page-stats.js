import { initAdminPage } from './supabase.js';
import { loadGlobalStats } from './stats.js';

initAdminPage(loadGlobalStats);
