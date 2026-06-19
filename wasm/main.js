document.getElementById('search').addEventListener('click', () => {
    const maxId = parseInt(document.getElementById('maxId').value, 10);
    const targetHex = document.getElementById('target').value.trim() || "00";
    const maskHex = document.getElementById('mask').value.trim() || "00";
    
    const output = document.getElementById('output');
    const btn = document.getElementById('search');

    output.textContent = "";
    btn.disabled = true;

    const numThreads = (navigator.hardwareConcurrency || 4) * 2; // 2x oversubscribing
    const chunkSize = Math.ceil(maxId / numThreads);
    
    let completedWorkers = 0;
    const startTime = performance.now();

    for (let i = 0; i < numThreads; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, maxId);
        if (start >= maxId) break;

        const worker = new Worker('worker.js', { type: 'module' });
        
        worker.onmessage = (e) => {

            if (e.data.result?.length) {
                output.appendChild(document.createTextNode(e.data.result.join('\n') + '\n'));
            }

            completedWorkers++;
            worker.terminate();

            if (completedWorkers === numThreads) {
                const elapsed = performance.now() - startTime;
                const rate = Math.round((maxId / elapsed) * 1000);

                const stats = `\nCompleted in ${elapsed.toFixed(2)} ms\nRate: ${rate} IDs/sec\n`;
                output.appendChild(document.createTextNode(stats));
                btn.disabled = false;
            }
        };

        worker.postMessage({ start, end, targetHex, maskHex });
    }
});
