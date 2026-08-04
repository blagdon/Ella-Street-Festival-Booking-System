// @ts-check
import { initAdminPage } from './supabase.js';
import { initEventConfig } from './settings/event-config.js';

initAdminPage(initEventConfig);
