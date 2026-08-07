// @ts-check
import { getSupabaseClient } from './supabase.js';
import { showToast, registerModalClose, trapFocus } from './ui.js';
import { escapeHtml, countSmsSegments } from './utils.js';
import { getCurrentOrgId } from './config.js';

// SMS twin of page-email-admin.js. Same sidebar/editor/mobile-toggle/preview
// shape; the differences are all because SMS is plain text, not HTML:
//   - no subject field (the table has no subject column)
//   - a live billed-segment counter instead of an HTML body
//   - the preview renders via textContent (an SMS is never HTML)
//
// Formerly a standalone page (sms_admin.html), now one pane of
// comms_admin.html (see page-comms-admin.js, which imports initSmsAdmin()
// and calls initAdminPage() exactly once for the whole merged page — this
// module must NOT call initAdminPage itself). Every element id below is
// prefixed `sms-` so it can coexist with the email pane's ids
// (page-email-admin.js), which were identical to these when each lived on
// its own page.
const sb = getSupabaseClient();
let allTemplates = [];
let currentTemplateId = null;
let unregisterPreviewModalEsc = null;
let releasePreviewModalFocus = null;

export function initSmsAdmin() {
    loadTemplates();

    const btnPreview = document.getElementById('sms-btn-preview');
    if (btnPreview) btnPreview.addEventListener('click', previewSms);

    const btnSaveTemplate = document.getElementById('sms-btn-save-template');
    if (btnSaveTemplate) btnSaveTemplate.addEventListener('click', saveTemplate);

    const inputBody = document.getElementById('sms-inputBody');
    if (inputBody) inputBody.addEventListener('input', updateSegCounter);

    const btnBackToTemplates = document.getElementById('sms-btn-back-to-templates');
    if (btnBackToTemplates) {
        btnBackToTemplates.addEventListener('click', () => {
            document.getElementById('sms-pane')?.classList.remove('mobile-detail-active');
        });
    }

    // Delegation for modal close.
    document.body.addEventListener('click', (e) => {
        const target = /** @type {Element} */ (e.target);
        if (target.closest('[data-action="close-preview-sms"]')) {
            closePreview();
        }
    });
}

async function loadTemplates() {
    try {
        const { data, error } = await sb.from('sms_templates').select('*').eq('org_id', getCurrentOrgId()).order('id');
        if (error) throw error;

        allTemplates = data;
        renderSidebar();
    } catch (err) {
        showToast("Failed to load templates: " + err.message, "error");
    }
}

function renderSidebar() {
    const listEl = document.getElementById('sms-templateList');
    listEl.innerHTML = '';

    if (allTemplates.length === 0) {
        listEl.innerHTML = '<div class="p-6 text-center text-gray-400 text-sm">No templates found.</div>';
        return;
    }

    allTemplates.forEach(t => {
        const div = document.createElement('div');
        div.className = `p-4 border-b border-gray-100 cursor-pointer hover:bg-gray-50 transition-colors template-item ${currentTemplateId === t.id ? 'active-template' : ''}`;
        div.setAttribute('role', 'button');
        div.setAttribute('tabindex', '0');
        div.setAttribute('aria-label', `${formatName(t.id)} SMS template`);
        div.onclick = () => selectTemplate(t.id);
        div.onkeydown = (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                selectTemplate(t.id);
            }
        };

        div.innerHTML = `
                <div class="font-bold text-gray-800 text-sm truncate">${formatName(t.id)}</div>
                <div class="text-xs text-gray-500 mt-1 truncate">${escapeHtml(t.body || '')}</div>
            `;
        listEl.appendChild(div);
    });
}

function selectTemplate(id) {
    currentTemplateId = id;
    renderSidebar(); // Update active highlights

    const template = allTemplates.find(t => t.id === id);
    if (!template) return;

    document.getElementById('sms-editorTitle').innerText = formatName(template.id);
    document.getElementById('sms-editorDesc').innerText = template.description || "No description provided.";
    (/** @type {HTMLTextAreaElement} */ (document.getElementById('sms-inputBody'))).value = template.body || '';
    updateSegCounter();

    document.getElementById('sms-emptyState').style.display = 'none';
    document.getElementById('sms-editorArea').style.display = 'flex';

    // Mobile: switch to editor view.
    document.getElementById('sms-pane')?.classList.add('mobile-detail-active');
}

async function saveTemplate() {
    if (!currentTemplateId) return;

    const btn = /** @type {HTMLButtonElement} */ (document.getElementById('sms-btn-save-template'));
    const newBody = (/** @type {HTMLTextAreaElement} */ (document.getElementById('sms-inputBody'))).value.trim();

    if (!newBody) {
        showToast("Message text cannot be empty.", "error");
        return;
    }

    btn.disabled = true;
    btn.innerText = "Saving...";

    try {
        const { error } = await sb.from('sms_templates')
            .update({
                body: newBody,
                updated_at: new Date().toISOString()
            })
            .eq('org_id', getCurrentOrgId())
            .eq('id', currentTemplateId);

        if (error) throw error;

        const idx = allTemplates.findIndex(t => t.id === currentTemplateId);
        if (idx > -1) allTemplates[idx].body = newBody;
        renderSidebar();

        showToast("Template Saved!", "success");
    } catch (err) {
        showToast("Error saving: " + err.message, "error");
    } finally {
        btn.disabled = false;
        btn.innerText = "Save Changes";
    }
}

// Helper to format 'booking_confirmed' into 'Booking Confirmed'.
function formatName(str) {
    return str.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

// Sample values for the placeholder set getSmsFromTemplate (js/message-templates.js)
// knows how to substitute — kept in sync with that list, which is the SMS
// subset of the email placeholders.
//
// {{payment_link}} is deliberately absent from that list: only
// create-checkout-session has the Stripe context to build the real URL, so
// getSmsFromTemplate never substitutes it. Shown here with a readable
// placeholder instead, so an admin previewing "payment_requested" sees
// intent rather than an unreplaced token.
const SAMPLE_DATA = {
    '{{owner_name}}': 'John Smith',
    '{{business_name}}': 'The Burger Shack',
    '{{booking_id}}': 'ESF26-FOOD-0042',
    '{{cost}}': '£50.00',
    '{{reason}}': 'Oversubscribed / Category Full',
    // Plain hyphen, not an em dash: this string feeds the same segment
    // counter the real preview uses, and a non-GSM-7 character here would
    // misreport the encoding/part count for a message that, once the real
    // link is substituted at send time, is actually plain ASCII.
    '{{payment_link}}': '[pay link - generated at send time]'
};

function fillSampleData(text) {
    let out = text;
    Object.keys(SAMPLE_DATA).forEach(placeholder => {
        // Escape the braces for the regex; placeholders are literal strings.
        const pattern = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp(pattern, 'g'), SAMPLE_DATA[placeholder]);
    });
    return out;
}

function updateSegCounter() {
    const text = (/** @type {HTMLTextAreaElement} */ (document.getElementById('sms-inputBody'))).value;
    const { len, parts, encoding } = countSmsSegments(text);
    const counterEl = document.getElementById('sms-segCounter');
    counterEl.textContent = `${len} character${len !== 1 ? 's' : ''} · ${parts} SMS part${parts !== 1 ? 's' : ''}`;
    // Nudge the admin when a "confirmation" has spilled into multiple billed parts.
    counterEl.className = parts > 1 ? 'text-amber-600 font-medium' : '';
    document.getElementById('sms-segEncoding').textContent = encoding;
}

function previewSms() {
    const body = (/** @type {HTMLTextAreaElement} */ (document.getElementById('sms-inputBody'))).value.trim();
    if (!body) {
        showToast("Please write some message text before previewing.", "error");
        return;
    }

    const rendered = fillSampleData(body);
    // textContent, not innerHTML: an SMS is plain text and must never be
    // interpreted as markup (both correctness and XSS).
    document.getElementById('sms-previewBody').textContent = rendered;

    const { len, parts, encoding } = countSmsSegments(rendered);
    document.getElementById('sms-previewMeta').textContent =
        `${len} character${len !== 1 ? 's' : ''} · ${parts} SMS part${parts !== 1 ? 's' : ''} · ${encoding}`;

    document.getElementById('sms-previewModal').classList.remove('hidden');
    unregisterPreviewModalEsc = registerModalClose(closePreview);
    releasePreviewModalFocus = trapFocus(document.getElementById('sms-previewModal'));
}

function closePreview() {
    document.getElementById('sms-previewModal').classList.add('hidden');
    if (unregisterPreviewModalEsc) { unregisterPreviewModalEsc(); unregisterPreviewModalEsc = null; }
    if (releasePreviewModalFocus) { releasePreviewModalFocus(); releasePreviewModalFocus = null; }
}
