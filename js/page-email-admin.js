import { initAdminPage, getSupabaseClient } from './supabase.js';
import { showToast } from './ui.js';

const sb = getSupabaseClient();
let allTemplates = [];
let currentTemplateId = null;

function init() {
    loadTemplates();

    // Event Listeners for statically loaded DOM elements that had click handlers
    const btnPreviewEmail = document.getElementById('btn-preview-email');
    if (btnPreviewEmail) btnPreviewEmail.addEventListener('click', previewEmail);

    const btnSaveTemplate = document.getElementById('btn-save-template');
    if (btnSaveTemplate) btnSaveTemplate.addEventListener('click', saveTemplate);

    // Delegation for Modal Close
    document.body.addEventListener('click', (e) => {
        const closePreviewBtn = e.target.closest('[data-action="close-preview"]');
        if (closePreviewBtn) {
            closePreview();
            return;
        }
    });
}
initAdminPage(init);

async function loadTemplates() {
    try {
        const { data, error } = await sb.from('email_templates').select('*').order('id');
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
        div.onclick = () => selectTemplate(t.id);

        div.innerHTML = `
                <div class="font-bold text-gray-800 text-sm truncate">${formatName(t.id)}</div>
                <div class="text-xs text-gray-500 mt-1 truncate">${t.subject}</div>
            `;
        listEl.appendChild(div);
    });
}

function selectTemplate(id) {
    currentTemplateId = id;
    renderSidebar(); // Update active highlights

    const template = allTemplates.find(t => t.id === id);
    if (!template) return;

    // Populate editor
    document.getElementById('editorTitle').innerText = formatName(template.id);
    document.getElementById('editorDesc').innerText = template.description || "No description provided.";
    document.getElementById('inputSubject').value = template.subject;
    document.getElementById('inputBody').value = template.body_html;

    // Toggle Views
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('editorArea').style.display = 'flex';
}

async function saveTemplate() {
    if (!currentTemplateId) return;

    const btn = document.getElementById('btn-save-template');

    const newSubject = document.getElementById('inputSubject').value.trim();
    const newBody = document.getElementById('inputBody').value.trim();

    if (!newSubject || !newBody) {
        showToast("Subject and Body cannot be empty.", "error");
        return;
    }

    btn.disabled = true;
    btn.innerText = "Saving...";

    try {
        const { error } = await sb.from('email_templates')
            .update({
                subject: newSubject,
                body_html: newBody,
                updated_at: new Date().toISOString()
            })
            .eq('id', currentTemplateId);

        if (error) throw error;

        // Update local state
        const idx = allTemplates.findIndex(t => t.id === currentTemplateId);
        if (idx > -1) {
            allTemplates[idx].subject = newSubject;
            allTemplates[idx].body_html = newBody;
        }
        renderSidebar();


        // Show success toast
        showToast("Template Saved!", "success");

    } catch (err) {
        showToast("Error saving: " + err.message, "error");
    } finally {
        btn.disabled = false;
        btn.innerText = "Save Changes";
    }
}

// Helper to format 'application_received' into 'Application Received'
function formatName(str) {
    return str.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

// Preview Email
function previewEmail() {
    const subject = document.getElementById('inputSubject').value.trim();
    const body = document.getElementById('inputBody').value.trim();

    if (!subject || !body) {
        showToast("Please fill in both subject and body before previewing.", "error");
        return;
    }

    // Sample data for placeholders
    const sampleData = {
        '{{owner_name}}': 'John Smith',
        '{{business_name}}': 'The Burger Shack',
        '{{booking_id}}': 'ESF26-FOOD-0042',
        '{{cancel_link}}': 'https://example.com/cancel/abc123',
        '{{cost}}': '£50.00',
        '{{bank_details}}': 'Account Name: Ella Street Festival, Sort Code: 12-34-56, Account Number: 12345678',
        '{{payment_link}}': 'https://checkout.stripe.com/c/pay/cs_test_example',
        '{{payment_reference}}': 'ESF26-FOOD-0042',
        '{{bank_account_name}}': 'Ella Street Festival',
        '{{bank_sort_code}}': '12-34-56',
        '{{bank_account_number}}': '12345678',
        '{{location_id}}': 'Zone A - 01',
        '{{reason}}': 'Unfortunately we cannot accommodate your stall at this time.',
        '{{email}}': 'john@burgershack.com',
        '{{phone}}': '07123 456789',
        '{{registered_business_name}}': 'Smith Burgers Ltd',
        '{{trader_list}}': `<table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                <thead>
                    <tr style="background-color: #f3f4f6;">
                        <th style="padding: 10px; border: 1px solid #ddd;">Booking ID</th>
                        <th style="padding: 10px; border: 1px solid #ddd;">Business</th>
                        <th style="padding: 10px; border: 1px solid #ddd;">Owner</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td style="padding: 8px; border: 1px solid #ddd;">ESF26-FOOD-0001</td>
                        <td style="padding: 8px; border: 1px solid #ddd;">Burger Shack</td>
                        <td style="padding: 8px; border: 1px solid #ddd;">John Smith</td>
                    </tr>
                    <tr>
                        <td style="padding: 8px; border: 1px solid #ddd;">ESF26-FOOD-0002</td>
                        <td style="padding: 8px; border: 1px solid #ddd;">Coffee Cart</td>
                        <td style="padding: 8px; border: 1px solid #ddd;">Jane Doe</td>
                    </tr>
                </tbody>
            </table>`
    };

    // Replace placeholders in subject
    let previewSubject = subject;
    Object.keys(sampleData).forEach(placeholder => {
        previewSubject = previewSubject.replace(new RegExp(placeholder, 'g'), sampleData[placeholder]);
    });

    // Replace placeholders in body
    let previewBody = body;
    Object.keys(sampleData).forEach(placeholder => {
        previewBody = previewBody.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), sampleData[placeholder]);
    });

    // Display preview
    document.getElementById('previewSubject').textContent = previewSubject;
    document.getElementById('previewBody').innerHTML = previewBody;
    document.getElementById('previewModal').classList.remove('hidden');
}

function closePreview() {
    document.getElementById('previewModal').classList.add('hidden');
}
