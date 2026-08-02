// @ts-check
/**
 * js/page-provisioning.js
 * Epic 3 — Platform Provisioning Wizard View.
 * Self-service organisation onboarding with pre-flight dry-run validation and provisioning report.
 */
import { getSupabaseClient } from './supabase.js';
import { getPlatformContext, CONFIG } from './config.js';
import { escapeHtml } from './utils.js';
import { renderPageHeader } from './platform/layout.js';
import { renderCard } from './platform/cards.js';
import { renderInputField } from './platform/forms.js';
import { renderStatusBadge } from './platform/tables.js';
import { notify } from './platform/notifications.js';

let wizardState = {
    step: 1,
    orgName: '',
    orgSlug: '',
    ownerEmail: '',
    website: '',
    eventName: '',
    eventPrefix: '',
    eventSlug: '',
    preflightValid: false,
    preflightError: '',
    provisioningReport: null
};

/**
 * Main entry point for rendering the Provisioning Wizard in the Admin Workspace.
 * @param {HTMLElement} container
 */
export function renderProvisioningSection(container) {
    const headerHtml = renderPageHeader({
        title: 'Organisation Setup Wizard',
        description: 'Provision a brand-new customer organisation, primary event, and platform defaults.',
        breadcrumb: 'Platform Administration / Provisioning'
    });

    const stepperHtml = `
    <div class="mb-8">
        <div class="flex items-center justify-between border-b border-gray-200 pb-4">
            <div class="flex items-center gap-2 ${wizardState.step === 1 ? 'text-blue-600 font-bold' : 'text-gray-500'}">
                <span class="w-7 h-7 flex items-center justify-center rounded-full border ${wizardState.step === 1 ? 'border-blue-600 bg-blue-50' : 'border-gray-300'} text-xs">1</span>
                <span class="text-sm">Organisation</span>
            </div>
            <span class="text-gray-300">→</span>
            <div class="flex items-center gap-2 ${wizardState.step === 2 ? 'text-blue-600 font-bold' : 'text-gray-500'}">
                <span class="w-7 h-7 flex items-center justify-center rounded-full border ${wizardState.step === 2 ? 'border-blue-600 bg-blue-50' : 'border-gray-300'} text-xs">2</span>
                <span class="text-sm">Primary Event</span>
            </div>
            <span class="text-gray-300">→</span>
            <div class="flex items-center gap-2 ${wizardState.step === 3 ? 'text-blue-600 font-bold' : 'text-gray-500'}">
                <span class="w-7 h-7 flex items-center justify-center rounded-full border ${wizardState.step === 3 ? 'border-blue-600 bg-blue-50' : 'border-gray-300'} text-xs">3</span>
                <span class="text-sm">Defaults</span>
            </div>
            <span class="text-gray-300">→</span>
            <div class="flex items-center gap-2 ${wizardState.step === 4 ? 'text-blue-600 font-bold' : 'text-gray-500'}">
                <span class="w-7 h-7 flex items-center justify-center rounded-full border ${wizardState.step === 4 ? 'border-blue-600 bg-blue-50' : 'border-gray-300'} text-xs">4</span>
                <span class="text-sm">Preview</span>
            </div>
            <span class="text-gray-300">→</span>
            <div class="flex items-center gap-2 ${wizardState.step === 5 ? 'text-emerald-600 font-bold' : 'text-gray-500'}">
                <span class="w-7 h-7 flex items-center justify-center rounded-full border ${wizardState.step === 5 ? 'border-emerald-600 bg-emerald-50' : 'border-gray-300'} text-xs">5</span>
                <span class="text-sm">Report</span>
            </div>
        </div>
    </div>`;

    let stepContentHtml = '';

    if (wizardState.step === 1) {
        stepContentHtml = `
        <form id="wizardStep1Form">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                ${renderInputField({ id: 'wOrgName', label: 'Organisation Name', value: wizardState.orgName, required: true, placeholder: 'e.g. Hull Summer Festival Ltd' })}
                ${renderInputField({ id: 'wOrgSlug', label: 'Organisation Slug (ID)', value: wizardState.orgSlug, required: true, placeholder: 'e.g. hull-summer', helpText: 'Unique tenant identifier' })}
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
                ${renderInputField({ id: 'wOwnerEmail', label: 'Owner Email Address', type: 'email', value: wizardState.ownerEmail, required: true, placeholder: 'owner@hullsummer.co.uk' })}
                ${renderInputField({ id: 'wWebsite', label: 'Official Website', value: wizardState.website, placeholder: 'https://hullsummer.co.uk' })}
            </div>
            <div class="flex justify-end mt-6">
                <button type="submit" class="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-lg shadow-sm transition">Continue to Event Setup →</button>
            </div>
        </form>`;
    } else if (wizardState.step === 2) {
        stepContentHtml = `
        <form id="wizardStep2Form">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                ${renderInputField({ id: 'wEventName', label: 'Primary Event Name', value: wizardState.eventName, required: true, placeholder: 'e.g. Hull Summer Festival 2027' })}
                ${renderInputField({ id: 'wEventPrefix', label: 'Booking Reference Prefix', value: wizardState.eventPrefix, required: true, placeholder: 'e.g. HSF27', helpText: 'Used for booking IDs (e.g. HSF27-FOOD-0001)' })}
            </div>
            <div class="mt-2">
                ${renderInputField({ id: 'wEventSlug', label: 'Event Slug', value: wizardState.eventSlug, placeholder: 'e.g. hsf-2027' })}
            </div>
            <div class="flex justify-between mt-6">
                <button type="button" id="btnStepBack" class="px-4 py-2 border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm font-medium rounded-lg transition">← Back</button>
                <button type="submit" class="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-lg shadow-sm transition">Review Defaults →</button>
            </div>
        </form>`;
    } else if (wizardState.step === 3) {
        stepContentHtml = `
        <div class="space-y-4">
            <div class="p-4 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-900">
                <h4 class="font-bold mb-1">ℹ️ Platform Defaults Package</h4>
                <p>Provisioning will automatically clone isolated platform seeds for this organisation:</p>
                <ul class="list-disc list-inside mt-2 space-y-1 text-xs">
                    <li>10 Standard Settings (Branding, Support Email, Allowed Stall Types)</li>
                    <li>4 Essential Email Templates (Application Received, Payment Requested, Confirmation, Cancellation)</li>
                    <li>3 SMS Templates (Submission, Payment Link, Cancellation)</li>
                </ul>
            </div>
            <div class="flex justify-between mt-6">
                <button type="button" id="btnStepBack" class="px-4 py-2 border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm font-medium rounded-lg transition">← Back</button>
                <button type="button" id="btnRunPreflight" class="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-lg shadow-sm transition">Run Pre-flight & Preview →</button>
            </div>
        </div>`;
    } else if (wizardState.step === 4) {
        stepContentHtml = `
        <div class="space-y-6">
            <div class="p-4 ${wizardState.preflightValid ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-amber-50 border-amber-200 text-amber-900'} border rounded-lg">
                <div class="flex items-center gap-2">
                    <span class="text-lg">${wizardState.preflightValid ? '✅' : '⚠️'}</span>
                    <span class="font-bold text-sm">${wizardState.preflightValid ? 'Pre-flight Validation Passed' : 'Pre-flight Check Required'}</span>
                </div>
                ${wizardState.preflightError ? `<p class="text-xs mt-1 text-red-700 font-semibold">${escapeHtml(wizardState.preflightError)}</p>` : ''}
            </div>

            <div class="border border-gray-200 rounded-lg p-4 bg-gray-50 space-y-3">
                <h4 class="text-xs font-bold uppercase tracking-wider text-gray-500 border-b pb-2">Provisioning Summary Preview</h4>
                <div class="grid grid-cols-2 gap-2 text-xs">
                    <div><strong class="text-gray-600">Organisation:</strong> ${escapeHtml(wizardState.orgName)} (${escapeHtml(wizardState.orgSlug)})</div>
                    <div><strong class="text-gray-600">Owner Email:</strong> ${escapeHtml(wizardState.ownerEmail)}</div>
                    <div><strong class="text-gray-600">Primary Event:</strong> ${escapeHtml(wizardState.eventName)} (${escapeHtml(wizardState.eventPrefix)})</div>
                    <div><strong class="text-gray-600">Initial Status:</strong> <span class="font-semibold text-amber-700">Draft</span></div>
                </div>
            </div>

            <div class="flex justify-between mt-6">
                <button type="button" id="btnStepBack" class="px-4 py-2 border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm font-medium rounded-lg transition">← Back</button>
                <button type="button" id="btnConfirmProvision" class="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm rounded-lg shadow transition flex items-center gap-2" ${!wizardState.preflightValid ? 'disabled opacity-50' : ''}>
                    <span>🚀</span>
                    <span>Provision Organisation</span>
                </button>
            </div>
        </div>`;
    } else if (wizardState.step === 5 && wizardState.provisioningReport) {
        const r = wizardState.provisioningReport;
        stepContentHtml = `
        <div class="space-y-6">
            <div class="p-5 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-900">
                <div class="flex items-center gap-3">
                    <span class="text-3xl">🎉</span>
                    <div>
                        <h3 class="text-lg font-bold">Organisation Provisioned Successfully!</h3>
                        <p class="text-xs text-emerald-700">Tenant ${escapeHtml(r.org_name)} is fully operational.</p>
                    </div>
                </div>
            </div>

            <div class="border border-gray-200 rounded-lg divide-y divide-gray-100 bg-white">
                <div class="p-3 flex justify-between text-xs"><span>Organisation ID</span><strong class="font-mono">${escapeHtml(r.org_id)}</strong></div>
                <div class="p-3 flex justify-between text-xs"><span>Owner Account</span><strong>${escapeHtml(r.owner_email)}</strong></div>
                <div class="p-3 flex justify-between text-xs"><span>Primary Event</span><strong>${escapeHtml(r.event_name)} (${escapeHtml(r.booking_prefix)})</strong></div>
                <div class="p-3 flex justify-between text-xs"><span>Settings Cloned</span><strong class="text-blue-600">${r.settings_initialised}</strong></div>
                <div class="p-3 flex justify-between text-xs"><span>Email Templates Cloned</span><strong class="text-blue-600">${r.email_templates_initialised}</strong></div>
                <div class="p-3 flex justify-between text-xs"><span>SMS Templates Cloned</span><strong class="text-blue-600">${r.sms_templates_initialised}</strong></div>
            </div>

            <div class="p-4 bg-gray-50 border border-gray-200 rounded-lg">
                <h4 class="text-xs font-bold uppercase tracking-wider text-gray-700 mb-2">Recommended Next Actions</h4>
                <div class="flex flex-wrap gap-3">
                    <button type="button" id="btnSwitchToNewOrg" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition">Switch Context to ${escapeHtml(r.org_name)}</button>
                    <button type="button" id="btnResetWizard" class="px-4 py-2 border border-gray-300 text-gray-700 hover:bg-gray-50 text-xs font-semibold rounded-lg transition">Provision Another Organisation</button>
                </div>
            </div>
        </div>`;
    }

    const cardHtml = renderCard({
        title: wizardState.step === 5 ? 'Provisioning Report' : 'Provisioning Checklist',
        subtitle: wizardState.step === 5 ? 'Asset Summary' : `Step ${wizardState.step} of 5`,
        contentHtml: stepContentHtml
    });

    container.innerHTML = headerHtml + stepperHtml + cardHtml; // innerhtml-safe: UI components use escapeHtml internally

    attachWizardListeners(container);
}

function attachWizardListeners(container) {
    document.getElementById('wizardStep1Form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        wizardState.orgName = (/** @type {HTMLInputElement} */ (document.getElementById('wOrgName'))).value.trim();
        wizardState.orgSlug = (/** @type {HTMLInputElement} */ (document.getElementById('wOrgSlug'))).value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
        wizardState.ownerEmail = (/** @type {HTMLInputElement} */ (document.getElementById('wOwnerEmail'))).value.trim();
        wizardState.website = (/** @type {HTMLInputElement} */ (document.getElementById('wWebsite'))).value.trim();

        if (!wizardState.orgName || !wizardState.orgSlug || !wizardState.ownerEmail) {
            notify('Organisation Name, Slug, and Owner Email are required.', 'error');
            return;
        }

        wizardState.step = 2;
        renderProvisioningSection(container);
    });

    document.getElementById('wizardStep2Form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        wizardState.eventName = (/** @type {HTMLInputElement} */ (document.getElementById('wEventName'))).value.trim();
        wizardState.eventPrefix = (/** @type {HTMLInputElement} */ (document.getElementById('wEventPrefix'))).value.trim().toUpperCase();
        wizardState.eventSlug = (/** @type {HTMLInputElement} */ (document.getElementById('wEventSlug'))).value.trim().toLowerCase();

        if (!wizardState.eventName || !wizardState.eventPrefix) {
            notify('Event Name and Booking Prefix are required.', 'error');
            return;
        }

        wizardState.step = 3;
        renderProvisioningSection(container);
    });

    document.getElementById('btnStepBack')?.addEventListener('click', () => {
        if (wizardState.step > 1) {
            wizardState.step--;
            renderProvisioningSection(container);
        }
    });

    document.getElementById('btnRunPreflight')?.addEventListener('click', async () => {
        await executePreflightValidation(container);
    });

    document.getElementById('btnConfirmProvision')?.addEventListener('click', async () => {
        await executeProvisioning(container);
    });

    document.getElementById('btnSwitchToNewOrg')?.addEventListener('click', () => {
        if (wizardState.provisioningReport?.org_id) {
            localStorage.setItem('ESF_ORG_ID', wizardState.provisioningReport.org_id);
            if (wizardState.provisioningReport.event_id) {
                localStorage.setItem('ESF_EVENT_ID', wizardState.provisioningReport.event_id);
            }
            window.location.reload();
        }
    });

    document.getElementById('btnResetWizard')?.addEventListener('click', () => {
        wizardState = {
            step: 1,
            orgName: '',
            orgSlug: '',
            ownerEmail: '',
            website: '',
            eventName: '',
            eventPrefix: '',
            eventSlug: '',
            preflightValid: false,
            preflightError: '',
            provisioningReport: null
        };
        renderProvisioningSection(container);
    });
}

async function executePreflightValidation(container) {
    const sb = getSupabaseClient();
    try {
        const { data, error } = await sb.functions.invoke('provision-organisation', {
            body: {
                org_name: wizardState.orgName,
                org_slug: wizardState.orgSlug,
                owner_email: wizardState.ownerEmail,
                event_name: wizardState.eventName,
                event_prefix: wizardState.eventPrefix,
                event_slug: wizardState.eventSlug,
                website: wizardState.website,
                dry_run: true
            }
        });

        if (error) throw error;

        wizardState.preflightValid = true;
        wizardState.preflightError = '';
        wizardState.step = 4;
        renderProvisioningSection(container);
    } catch (err) {
        wizardState.preflightValid = false;
        wizardState.preflightError = err.message || 'Pre-flight validation failed';
        wizardState.step = 4;
        renderProvisioningSection(container);
    }
}

async function executeProvisioning(container) {
    const sb = getSupabaseClient();
    const btn = /** @type {HTMLButtonElement|null} */ (document.getElementById('btnConfirmProvision'));

    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Provisioning...';
    }

    try {
        const { data, error } = await sb.functions.invoke('provision-organisation', {
            body: {
                org_name: wizardState.orgName,
                org_slug: wizardState.orgSlug,
                owner_email: wizardState.ownerEmail,
                event_name: wizardState.eventName,
                event_prefix: wizardState.eventPrefix,
                event_slug: wizardState.eventSlug,
                website: wizardState.website,
                dry_run: false
            }
        });

        if (error) throw error;

        wizardState.provisioningReport = data;
        wizardState.step = 5;
        notify('Organisation provisioned successfully!', 'success');
        renderProvisioningSection(container);
    } catch (err) {
        notify(`Provisioning failed: ${err.message}`, 'error');
        if (btn) {
            btn.disabled = false;
            btn.innerText = '🚀 Provision Organisation';
        }
    }
}
