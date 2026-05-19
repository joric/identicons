import init, { Scanner } from './pkg/md5_scanner.js';

self.onmessage = async (e) => {
    const { start, end, targetHex, maskHex } = e.data;
    await init();
    
    const scanner = new Scanner();
    
    try {
        scanner.set_mask_and_target(maskHex, targetHex);
    } catch (err) {
        console.error("Mask error:", err);
    }
    
    const result = scanner.scan_range(start, end);
    self.postMessage({ result });
};
