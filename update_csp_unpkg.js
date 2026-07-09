const fs = require('fs');
const path = require('path');

const dir = 'c:/Users/shaun/OneDrive/Documents/Fest 26 Booking System/New booking system/Test Deploy tailwinds change';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));

const domainsToAdd = {
    'connect-src': ['https://unpkg.com']
};

let updatedCount = 0;

for (const file of files) {
    const filePath = path.join(dir, file);
    let content = fs.readFileSync(filePath, 'utf-8');

    const cspRegex = /<meta\s+http-equiv="Content-Security-Policy"\s*[\r\n\s]*content="([^"]+)">/i;
    const match = cspRegex.exec(content);

    if (match) {
        let cspStr = match[1];
        let directives = cspStr.split(';').map(d => d.trim()).filter(d => d.length > 0);
        let modified = false;

        for (let i = 0; i < directives.length; i++) {
            let parts = directives[i].split(/\s+/);
            const key = parts[0];

            if (domainsToAdd[key]) {
                let changed = false;
                for (const domain of domainsToAdd[key]) {
                    if (!parts.includes(domain)) {
                        parts.push(domain);
                        changed = true;
                    }
                }
                if (changed) {
                    directives[i] = parts.join(' ');
                    modified = true;
                }
            }
        }

        if (modified) {
            const newCspStr = directives.join('; ') + ';';
            const fullMatchRegex = /<meta\s+http-equiv="Content-Security-Policy"\s*[\r\n\s]*content="[^"]*">/i;
            content = content.replace(fullMatchRegex, `<meta http-equiv="Content-Security-Policy"\n        content="${newCspStr}">`);
            fs.writeFileSync(filePath, content, 'utf-8');
            console.log(`Updated connect-src in ${file}`);
            updatedCount++;
        }
    }
}
console.log(`Updated connect-src in ${updatedCount} files.`);
