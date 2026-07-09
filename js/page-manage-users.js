import { initNavigation } from './nav.js';
import { requireAuth, getSupabaseClient } from './supabase.js';
import { CONFIG } from './config.js';
import { showToast } from './ui.js';
import { escapeHtml } from './utils.js';

let adminSb; // Main (admin) client

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await requireAuth('admin');
        initNavigation();
    } catch (e) { return; }

    adminSb = getSupabaseClient();
    loadUsers();

    // Attach static event listeners
    const createBtn = document.getElementById('createBtn');
    if (createBtn) createBtn.addEventListener('click', createUser);

    const refreshBtn = document.getElementById('btn-refresh-users');
    if (refreshBtn) refreshBtn.addEventListener('click', loadUsers);

    // Event delegation for dynamic delete buttons
    const userList = document.getElementById('userList');
    if (userList) {
        userList.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-action="delete"]');
            if (btn) {
                deleteUser(btn.dataset.id, btn.dataset.label);
            }
        });
    }
});

// ---- LOAD EXISTING USERS ----
async function loadUsers() {
    const listEl = document.getElementById('userList');
    listEl.innerHTML = '<div class="text-center py-6 text-gray-400 text-sm animate-pulse">Loading...</div>';

    try {
        const { data, error } = await adminSb
            .from('user_roles')
            .select('id, role, email, created_at')
            .order('created_at', { ascending: false });

        if (error) throw error;

        if (!data || data.length === 0) {
            listEl.innerHTML = '<div class="text-center py-6 text-gray-400 text-sm">No users found.</div>';
            return;
        }

        listEl.innerHTML = data.map(u => `
            <div class="flex items-center justify-between p-3 rounded-lg bg-gray-50 border border-gray-100 fade-in">
                <div class="min-w-0 flex-1 pr-2">
                    <div class="text-sm font-medium text-gray-700 truncate">${escapeHtml(u.email || '(no email)')}</div>
                    <div class="text-xs text-gray-400 mt-0.5">${new Date(u.created_at).toLocaleDateString('en-GB')}</div>
                </div>
                <div class="flex items-center gap-2 flex-shrink-0">
                    <span class="text-xs font-bold px-2 py-1 rounded-full role-badge-${escapeHtml(u.role)}">
                        ${escapeHtml(u.role.charAt(0).toUpperCase() + u.role.slice(1))}
                    </span>
                    <button data-action="delete" data-id="${escapeHtml(u.id)}" data-label="${escapeHtml(u.email || u.id)}"
                        title="Remove access"
                        class="text-gray-300 hover:text-red-500 transition-colors p-1 rounded">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16">
                            </path>
                        </svg>
                    </button>
                </div>
            </div>
        `).join('');
    } catch (err) {
        listEl.innerHTML = `<div class="text-center py-4 text-red-500 text-sm">Error: ${escapeHtml(err.message)}</div>`;
    }
}

// ---- DELETE USER ----
async function deleteUser(id, label) {
    if (!confirm(`Remove access for "${label}"?\n\nThis removes their system role. Their login account will remain but they will not be able to access the admin system.`)) return;

    try {
        const { error } = await adminSb.from('user_roles').delete().eq('id', id);
        if (error) throw error;
        showToast('Access removed for user.', 'success');
        loadUsers();
    } catch (err) {
        showToast('Failed to remove user: ' + err.message, 'error');
    }
}

// ---- CREATE USER ----
async function createUser() {
    const email = document.getElementById('newEmail').value.trim();
    const password = document.getElementById('newPassword').value;
    const role = document.getElementById('newRole').value;
    const btn = document.getElementById('createBtn');
    const msgEl = document.getElementById('createMsg');

    // Validation
    if (!email || !password) {
        showToast('Please fill in all fields.', 'error');
        return;
    }
    if (password.length < 8) {
        showToast('Password must be at least 8 characters.', 'error');
        return;
    }

    btn.disabled = true;
    btn.innerText = 'Creating...';

    try {
        // Use a SEPARATE client so the admin's own session is NOT replaced
        // Need to import supabase globally since it's via CDN.
        const tmpClient = window.supabase.createClient(CONFIG.SUPABASE.URL, CONFIG.SUPABASE.KEY, {
            auth: {
                persistSession: false,    // Don't save this session to localStorage
                autoRefreshToken: false,
                detectSessionInUrl: false
            }
        });

        // 1. Create the user account
        const { data: signUpData, error: signUpErr } = await tmpClient.auth.signUp({
            email: email,
            password: password,
            options: {
                // Prevent auto-redirect on confirm — admin manages the URL
                emailRedirectTo: window.location.origin + '/login.html'
            }
        });

        if (signUpErr) throw signUpErr;
        if (!signUpData.user) throw new Error('User creation returned no user object. Email may already be in use.');

        if (!signUpData.user.identities || signUpData.user.identities.length === 0) {
            throw new Error('Email address already exists. Please use a different email address.');
        }

        const newUserId = signUpData.user.id;

        // 2. Assign the role in user_roles table
        const { error: roleErr } = await adminSb.from('user_roles').upsert({
            id: newUserId,
            role: role,
            email: email
        }, { onConflict: 'id' });

        if (roleErr) throw roleErr;

        // 3. Success
        showToast(`✓ Account created for ${email} as ${role}. They will receive a verification email.`, 'success');
        document.getElementById('newEmail').value = '';
        document.getElementById('newPassword').value = '';
        loadUsers(); // Refresh list

    } catch (err) {
        showToast('Error: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerText = 'Create Account';
    }
}

function showMsg(text, type) {
    const el = document.getElementById('createMsg');
    el.innerText = text;
    el.className = type === 'success'
        ? 'text-sm font-semibold rounded-lg px-3 py-2 bg-green-50 text-green-700 border border-green-200'
        : 'text-sm font-semibold rounded-lg px-3 py-2 bg-red-50 text-red-700 border border-red-200';
    el.classList.remove('hidden');
}
