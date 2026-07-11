import { initAdminPage } from './supabase.js';
import { initPayments } from './payments.js';

initAdminPage(initPayments);
