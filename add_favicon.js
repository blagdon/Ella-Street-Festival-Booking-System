const fs = require('fs');
const path = require('path');

const dir = 'c:/Users/shaun/OneDrive/Documents/Fest 26 Booking System/New booking system/Test Deploy tailwinds change';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));

const faviconTag = '\n    <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🎪</text></svg>">';

let updatedCount = 0;

for (const file of files) {
    const filePath = path.join(dir, file);
    let content = fs.readFileSync(filePath, 'utf-8');

    // Only inject if it doesn't already have one
    if (!content.includes('rel="icon"')) {
        // Find the end of the <head> tag or a good place to inject
        const headEndIndex = content.indexOf('</head>');
        if (headEndIndex !== -1) {
            content = content.slice(0, headEndIndex) + faviconTag + '\n' + content.slice(headEndIndex);
            fs.writeFileSync(filePath, content, 'utf-8');
            console.log(`Added favicon to ${file}`);
            updatedCount++;
        }
    }
}

console.log(`Updated ${updatedCount} files with a favicon.`);
