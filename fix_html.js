const fs = require('fs');

// Fix login.html
let loginHtml = fs.readFileSync('login.html', 'utf8');
loginHtml = loginHtml.replace(/onclick="toggleView\('reset'\)"/g, 'id="link-forgot-password"');
loginHtml = loginHtml.replace(/onclick="toggleView\('login'\)"/g, 'id="link-back-login"');
loginHtml = loginHtml.replace(/<script type="module">[\s\S]*?<\/script>/g, '<script type="module" src="./js/page-login.js"></script>');
fs.writeFileSync('login.html', loginHtml);

// Fix more.html
let moreHtml = fs.readFileSync('more.html', 'utf8');
const routes = ['email_admin', 'update_details', 'manage_users', 'add_misc', 'steward'];
for (const route of routes) {
    const divRegex = new RegExp(`<div onclick="navigate\\('${route}'\\)"([\\s\\S]*?)<\/div>(?=\\s*<!--|\\s*<div|\\s*<a|\\s*<\/div>)`, 'g');

    // Instead of regex for the closing div, just do a string replace for the opening div and matching its specific close
    // Because HTML regex with balanced tags is unreliable, we know exactly what these blocks look like
}
// Actually, string replace is simpler:
moreHtml = moreHtml.replace(/<div onclick="navigate\('email_admin'\)"/g, '<a href="email_admin.html"').replace(/<p class="text-sm text-gray-500">Edit automated email wording.<\/p>\s*<\/div>/g, '<p class="text-sm text-gray-500">Edit automated email wording.</p>\n            </a>');
moreHtml = moreHtml.replace(/<div onclick="navigate\('update_details'\)"/g, '<a href="update_details.html"').replace(/<p class="text-sm text-gray-500">Manually edit individual booking details.<\/p>\s*<\/div>/g, '<p class="text-sm text-gray-500">Manually edit individual booking details.</p>\n            </a>');
moreHtml = moreHtml.replace(/<div onclick="navigate\('manage_users'\)"/g, '<a href="manage_users.html"').replace(/<p class="text-sm text-gray-500">Create and view admin &amp; steward accounts.<\/p>\s*<\/div>/g, '<p class="text-sm text-gray-500">Create and view admin &amp; steward accounts.</p>\n            </a>');
moreHtml = moreHtml.replace(/<div onclick="navigate\('add_misc'\)"/g, '<a href="add_misc.html"').replace(/<p class="text-sm text-gray-500">Manually insert confirmed misc records.<\/p>\s*<\/div>/g, '<p class="text-sm text-gray-500">Manually insert confirmed misc records.</p>\n            </a>');
moreHtml = moreHtml.replace(/<div onclick="navigate\('steward'\)"/g, '<a href="steward.html"').replace(/<p class="text-sm text-gray-500">Access the simplified steward dashboard.<\/p>\s*<\/div>/g, '<p class="text-sm text-gray-500">Access the simplified steward dashboard.</p>\n            </a>');

moreHtml = moreHtml.replace(/window\.navigate = function \(page\) \{[\s\S]*?\};/g, '');
fs.writeFileSync('more.html', moreHtml);

// Fix visitor_map.html
let mapHtml = fs.readFileSync('visitor_map.html', 'utf8');
mapHtml = mapHtml.replace(/oninput="handleSearch\(this\.value\)"/g, 'id="search-input-field"');
mapHtml = mapHtml.replace(/onclick="clearSearch\(\)"/g, 'id="btn-clear-search"');
mapHtml = mapHtml.replace(/onchange="applyFilter\(this\.value\)"/g, 'id="filter-select-field"');
mapHtml = mapHtml.replace(/onclick="locateUser\(\)"/g, 'id="btn-locate-user"');
fs.writeFileSync('visitor_map.html', mapHtml);

console.log('Successfully completed html fix script');
