const fs = require('fs');
const path = require('path');

const directoryPath = __dirname;

function processDirectory(dirPath) {
    fs.readdir(dirPath, (err, files) => {
        if (err) {
            console.error("Could not list the directory.", err);
            process.exit(1);
        }

        files.forEach((file, index) => {
            const filePath = path.join(dirPath, file);

            fs.stat(filePath, (error, stat) => {
                if (error) {
                    console.error("Error stating file.", error);
                    return;
                }

                if (stat.isFile() && filePath.endsWith('.html')) {
                    fs.readFile(filePath, 'utf8', (err, data) => {
                        if (err) {
                            console.error(`Error reading file ${file}`, err);
                            return;
                        }

                        // Regex to match script-src policy and remove 'unsafe-inline' 
                        // Note: we're only going after script-src 'unsafe-inline', NOT style-src 'unsafe-inline' yet.
                        let updatedData = data.replace(/script-src([^;]*?)'unsafe-inline'([^;]*?);/g, "script-src$1$2;");

                        // Clean up double spaces that might result from removal
                        updatedData = updatedData.replace(/script-src([^;]*?)  ([^;]*?);/g, "script-src$1 $2;");

                        if (data !== updatedData) {
                            fs.writeFile(filePath, updatedData, 'utf8', (err) => {
                                if (err) console.error(`Error writing file ${file}`, err);
                                else console.log(`Updated CSP in ${file}`);
                            });
                        }
                    });
                }
            });
        });
    });
}

processDirectory(directoryPath);
