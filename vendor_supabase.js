const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
const VENDOR_DIR = path.join(__dirname, 'js', 'vendor');
const VENDOR_FILE = path.join(VENDOR_DIR, 'supabase.js');

async function run() {
  try {
    // 1. Create vendor directory if it doesn't exist
    if (!fs.existsSync(VENDOR_DIR)) {
      fs.mkdirSync(VENDOR_DIR, { recursive: true });
    }

    // 2. Download Supabase JS SDK
    console.log('Downloading Supabase JS SDK...');
    const response = await fetch(SUPABASE_URL);
    if (!response.ok) throw new Error(`Failed to download Supabase SDK: ${response.statusText}`);
    const code = await response.text();
    fs.writeFileSync(VENDOR_FILE, code, 'utf-8');
    console.log(`Saved Supabase SDK to ${VENDOR_FILE}`);

    // 3. Scan all HTML files in current directory
    const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.html'));

    for (const file of files) {
      const filePath = path.join(__dirname, file);
      let content = fs.readFileSync(filePath, 'utf-8');
      let modified = false;

      // Replace Supabase script tag
      const scriptRegex = /<script\s+src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2"\s*><\/script>/gi;
      const scriptRegex2 = /<script\s+src='https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2'\s*><\/script>/gi;
      
      let newContent = content;
      if (scriptRegex.test(content) || scriptRegex2.test(content)) {
        newContent = content.replace(scriptRegex, '<script src="js/vendor/supabase.js"></script>');
        newContent = newContent.replace(scriptRegex2, '<script src="js/vendor/supabase.js"></script>');
        modified = true;
      }

      // Check if there are other script tags loading from jsdelivr
      const tempContent = newContent.replace(/<script[^>]*js\/vendor\/supabase\.js[^>]*><\/script>/gi, '');
      const hasOtherJsDelivr = /<script[^>]*src="https:\/\/cdn\.jsdelivr\.net/gi.test(tempContent);

      // Regex to parse Content-Security-Policy meta tag
      // Use [\s\S]*? to handle newlines between attributes
      const cspRegex = /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)">/gi;
      cspRegex.lastIndex = 0;
      const cspMatch = cspRegex.exec(newContent);

      if (cspMatch) {
        let cspStr = cspMatch[1];
        let directives = cspStr.split(';').map(d => d.trim()).filter(d => d.length > 0);
        let cspModified = false;

        for (let i = 0; i < directives.length; i++) {
          let parts = directives[i].split(/\s+/);
          const key = parts[0];

          if (key === 'script-src') {
            if (!hasOtherJsDelivr && parts.includes('https://cdn.jsdelivr.net')) {
              // Remove jsdelivr from script-src
              directives[i] = parts.filter(p => p !== 'https://cdn.jsdelivr.net').join(' ');
              cspModified = true;
            }
          }
        }

        if (cspModified) {
          const newCspStr = directives.join('; ') + ';';
          const fullMatchRegex = /<meta\s+http-equiv="Content-Security-Policy"\s*content="[^"]+">/gi;
          newContent = newContent.replace(fullMatchRegex, `<meta http-equiv="Content-Security-Policy" content="${newCspStr}">`);
          modified = true;
        }
      }

      if (modified) {
        fs.writeFileSync(filePath, newContent, 'utf-8');
        console.log(`Updated ${file}`);
      }
    }

    console.log('CSP Tightening and Vendoring complete successfully.');

  } catch (err) {
    console.error('Error running script:', err);
  }
}

run();
