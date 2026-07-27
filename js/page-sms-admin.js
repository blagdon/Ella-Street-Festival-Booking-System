import { initAdminPage, getSupabaseClient } from './supabase.js';
import { showToast } from './ui.js';
import { escapeHtml, countSmsSegments } from './utils.js';

// SMS twin of page-email-admin.js. Same sidebar/editor/mobile-toggle/preview
// shape; the differences are all because SMS is plain text, not HTML:
//   - no subject field (the table has no subject column)
//   - a live billed-segment counter instead of an HTML body
//   - the preview renders via textContent (an SMS is never HTML)
const sb = getSupabaseClient();
let allTemplates = [];
let currentTemplateId = null;

function init() {
    loadTemplates();

    const btnPreview = document.getElementById('btn-preview-sms');
    if (btnPreview) btnPreview.addEventListener('click', previewSms);

    const btnSaveTemplate = document.getElementById('btn-save-template');
    if (btnSaveTemplate) btnSaveTemplate.addEventListener('click', saveTemplate);

    const inputBody = document.getElementById('inputBody');
    if (inputBody) inputBody.addEventListener('input', updateSegCounter);

    const btnBackToTemplates = document.getElementById('btn-back-to-templates');
    if (btnBackToTemplates) {
        btnBackToTemplates.addEventListener('click', () => {
            document.getElementById('mobile-view-container')?.classList.remove('mobile-detail-active');
        });
    }

    // Delegation for modal close.
    document.body.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="close-preview"]')) {
            closePreview();
        }
    });
}
initAdminPage(init);

async function loadTemplates() {
    try {
        const { data, error } = await sb.from('sms_templates').select('*').order('id');
        if (error) throw error;

        allTemplates = data;
        renderSidebar();
    } catch (err) {
        showToast("Failed to load templates: " + err.message, "error");
    }
}

function renderSidebar() {
    const listEl = document.getElementById('templateList');
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

    document.getElementById('editorTitle').innerText = formatName(template.id);
    document.getElementById('editorDesc').innerText = template.description || "No description provided.";
    document.getElementById('inputBody').value = template.body || '';
    updateSegCounter();

    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('editorArea').style.display = 'flex';

    // Mobile: switch to editor view.
    document.getElementById('mobile-view-container')?.classList.add('mobile-detail-active');
}

async function saveTemplate() {
    if (!currentTemplateId) return;

    const btn = document.getElementById('btn-save-template');
    const newBody = document.getElementById('inputBody').value.trim();

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

// Sample values for the placeholder set getSmsFromTemplate (js/shared.js) knows
// how to substitute — kept in sync with that list, which is the SMS subset of
// the email placeholders.
const SAMPLE_DATA = {
    '{{owner_name}}': 'John Smith',
    '{{business_name}}': 'The Burger Shack',
    '{{booking_id}}': 'ESF26-FOOD-0042',
    '{{cost}}': '£50.00',
    '{{reason}}': 'Oversubscribed / Category Full'
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
    const text = document.getElementById('inputBody').value;
    const { len, parts, encoding } = countSmsSegments(text);
    const counterEl = document.getElementById('segCounter');
    counterEl.textContent = `${len} character${len !== 1 ? 's' : ''} · ${parts} SMS part${parts !== 1 ? 's' : ''}`;
    // Nudge the admin when a "confirmation" has spilled into multiple billed parts.
    counterEl.className = parts > 1 ? 'text-amber-600 font-medium' : '';
    document.getElementById('segEncoding').textContent = encoding;
}

function previewSms() {
    const body = document.getElementById('inputBody').value.trim();
    if (!body) {
        showToast("Please write some message text before previewing.", "error");
        return;
    }

    const rendered = fillSampleData(body);
    // textContent, not innerHTML: an SMS is plain text and must never be
    // interpreted as markup (both correctness and XSS).
    document.getElementById('previewBody').textContent = rendered;

    const { len, parts, encoding } = countSmsSegments(rendered);
    document.getElementById('previewMeta').textContent =
        `${len} character${len !== 1 ? 's' : ''} · ${parts} SMS part${parts !== 1 ? 's' : ''} · ${encoding}`;

    document.getElementById('previewModal').classList.remove('hidden');
}

function closePreview() {
    document.getElementById('previewModal').classList.add('hidden');
}
