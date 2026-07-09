const fs = require('fs');

// 1. visitor_map.html
let visitorHtml = fs.readFileSync('visitor_map.html', 'utf8');
visitorHtml = visitorHtml.replace(/<script type="module">[\s\S]*?<\/script>/g, '<script type="module" src="./js/page-visitor-map.js"></script>');
fs.writeFileSync('visitor_map.html', visitorHtml);

// 2. more.html, stats.html, payments.html
const initFiles = ['more.html', 'stats.html', 'payments.html'];
for (const f of initFiles) {
    let ht = fs.readFileSync(f, 'utf8');
    ht = ht.replace(/<script type="module">[\s\S]*?<\/script>/g, '<script type="module" src="./js/auth-init.js"></script>');
    fs.writeFileSync(f, ht);
}

// 3. update_details.html
let updHtml = fs.readFileSync('update_details.html', 'utf8');
updHtml = updHtml.replace(/<script type="module">[\s\S]*?<\/script>/g, '');
fs.writeFileSync('update_details.html', updHtml);

console.log('Fixed inline module scripts across HTML files.');
