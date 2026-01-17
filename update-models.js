const https = require('https');
const fs = require('fs-extra');
const path = require('path');

// Configuration
const MODELS_DIR = path.join(__dirname, 'models');
const INDEX_FILE = path.join(MODELS_DIR, 'index.json');
const BASE_URL = 'https://raw.githubusercontent.com/sunspec/models/master/json/';

// Common models to download
const MODEL_IDS = [
    1,   // Common
    101, // Inverter Single Phase
    102, // Inverter Split Phase  
    103, // Inverter Three Phase
    111, // Inverter MPPT Extension
    112, // Inverter Delta Connect 3 Phase
    113, // Inverter Wye Connect 3 Phase
    120, // Nameplate
    121, // Settings
    122, // Status
    123, // Controls
    124, // Storage
    125, // Pricing
    126, // Volt-Var
    127, // Freq-Watt Param
    128, // Dynamic Reactive Current
    129, // LVRT
    130, // HVRT
    131, // Watt-PF
    132, // Volt-Watt
    160  // MPPT Module
];

function downloadFile(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`));
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                }
            });
        }).on('error', reject);
    });
}

async function main() {
    console.log('Downloading official SunSpec models from GitHub...\n');

    await fs.ensureDir(MODELS_DIR);

    const index = {};
    let successCount = 0;
    let failCount = 0;

    for (const modelId of MODEL_IDS) {
        const url = `${BASE_URL}model_${modelId}.json`;
        const filename = `model_${modelId}.json`;
        const savePath = path.join(MODELS_DIR, filename);

        try {
            console.log(`Downloading Model ${modelId}...`);
            const content = await downloadFile(url);

            // Save individual file
            await fs.writeJson(savePath, content, { spaces: 2 });

            // Add to index (use model ID from content if available)
            const id = content.id || (content.group && content.group.id) || modelId;
            index[id] = content;

            const label = content.group && content.group.label;
            console.log(`  ✓ ${modelId} - ${label || 'Unknown'}`);
            successCount++;

        } catch (e) {
            console.error(`  ✗ Failed: ${e.message}`);
            failCount++;
        }
    }

    // Save index.json
    await fs.writeJson(INDEX_FILE, index, { spaces: 2 });

    console.log(`\n========================================`);
    console.log(`Downloaded: ${successCount} models`);
    console.log(`Failed: ${failCount} models`);
    console.log(`Index saved to: ${INDEX_FILE}`);
    console.log(`========================================`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
