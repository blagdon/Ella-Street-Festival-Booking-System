import { initAdminPage } from './supabase.js';
import { initToggles, initSystemConstants, initSentrySettings, initSerpApiSettings } from './settings/system.js';
import { initStripeSettings } from './settings/stripe.js';
import { initBankTransferSettings } from './settings/bank-transfer.js';
import { initStallCosts, initStallTypes } from './settings/costs.js';
import { initZohoSettings } from './settings/zoho.js';
import { initSmsSettings } from './settings/sms.js';

function initSettings() {
    initToggles();
    initStripeSettings();
    initBankTransferSettings();
    initStallCosts();
    initStallTypes();
    initSystemConstants();
    initZohoSettings();
    initSmsSettings();
    initSerpApiSettings();
    initSentrySettings();
}

initAdminPage(initSettings);
