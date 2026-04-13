const fs = require('fs');

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
    console.log("Fetching all models...");
    const r = await fetch('http://localhost:4920/api/models-with-metadata');
    const data = await r.json();
    const models = data.rows || [];

    console.log(`Found ${models.length} models to test.`);

    // Rate limit is 40 / min = 1 request every 1.5 seconds minimum.
    // We do up to 3 requests per test (latency, token limits, tool support).
    // So 1 test = 3 requests. 40 requests = ~13 tests per minute.
    // Delay per test = ~4.5 seconds to stay inside the limit.
    const delayMs = 5000;

    const resultsFile = 'model_limits_cache.json';
    let cache = {};
    if (fs.existsSync(resultsFile)) {
        cache = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    }

    for (let i = 0; i < models.length; i++) {
        const m = models[i];
        if (cache[m.modelId] && cache[m.modelId].contextLength !== "Unknown" && cache[m.modelId].toolSupportChecked === true) {
            console.log(`[${i + 1}/${models.length}] Skipping ${m.modelId}, already cached.`);
            continue;
        }

        console.log(`[${i + 1}/${models.length}] Testing ${m.modelId}...`);
        try {
            const tr = await fetch(`http://localhost:4920/api/test-model?model=${encodeURIComponent(m.modelId)}`);
            const tData = await tr.json();
            cache[m.modelId] = tData;
            fs.writeFileSync(resultsFile, JSON.stringify(cache, null, 2));
            console.log(`  -> Context: ${tData.contextLength}, Max Out: ${tData.maxOutputTokens}, Tool Support: ${tData.toolSupport}`);
        } catch (e) {
            console.error(`  -> Failed: ${e.message}`);
        }

        await delay(delayMs);
    }

    console.log("All testing completed.");
}

runTests();
