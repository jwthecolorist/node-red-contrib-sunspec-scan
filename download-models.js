
const fs = require('fs-extra');
const path = require('path');

// Configuration
const OUTPUT_DIR = path.join(__dirname, 'models');
const INDEX_FILE = path.join(OUTPUT_DIR, 'index.json');

async function main() {
    console.log(`Indexing models in ${OUTPUT_DIR}...`);

    // Ensure index.json doesn't interfere with directory listing if possible, 
    // but fs.readdir will verify extensions.

    if (!fs.existsSync(OUTPUT_DIR)) {
        console.error("Models directory not found.");
        return;
    }

    const files = await fs.readdir(OUTPUT_DIR);
    const index = {};
    let count = 0;

    for (const file of files) {
        if (file.endsWith('.json') && file !== 'index.json') {
            try {
                const filePath = path.join(OUTPUT_DIR, file);
                const content = await fs.readJson(filePath);

                // Identify the model ID
                // Some JSONs (sunspec 2) have { id: 1, ... } or { group: { id: 1 ... } }
                let id = null;

                if (content.id) {
                    id = content.id;
                } else if (content.group && content.group.id) {
                    id = content.group.id;
                }

                if (id) {
                    index[id] = content;
                    count++;
                } else {
                    console.warn(`Skipping ${file}: No ID found in JSON`);
                }

            } catch (e) {
                console.error(`Error reading ${file}:`, e.message);
            }
        }
    }

    // Save to index.json
    await fs.writeJson(INDEX_FILE, index, { spaces: 2 });
    console.log(`\nSuccessfully indexed ${count} models to ${INDEX_FILE}`);
}

main().catch(err => console.error(err));
