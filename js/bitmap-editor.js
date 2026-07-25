const BitmapEditor = (function() {
    const MAX_CANVAS_SIZE = 4096;

    function toHex(color) {
        if (color?.startsWith('#')) {
            let hex = color.slice(1);

            if (hex.length === 3) {
                hex = hex.split('').map(c => c + c).join('');
            }

            if (hex.length === 6) {
                return '#' + hex.toLowerCase();
            }
        }

        const ctx = document.createElement('canvas').getContext('2d');
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);

        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    }

    class BitmapEditorInstance {
        constructor(canvas, options) {
            this.w = options.width;
            this.h = options.height;
            this.ps = options.pixelSize;
            this.bg = toHex(options.backgroundColor);
            this.fg = toHex(options.foregroundColor);
            this.mh = options.mirrorHorizontal;
            this.bw = options.borderWidth;

            console.log(this);

            this.canvas = canvas;
            this.canvas.width = this.w * this.ps + this.bw * 2;
            this.canvas.height = this.h * this.ps + this.bw * 2;
            this.ctx = this.canvas.getContext('2d');

            this.canvas.style.cursor = 'crosshair';
            this.canvas.style.display = 'block';
            this.canvas.style.touchAction = 'none';

            this.pixels = Array.from(
                { length: this.h },
                () => Array(this.w).fill(this.bg)
            );

            this.history = [];
            this.historyIndex = -1;
            this.saveToHistory();

            this.isDrawing = false;
            this.activePointerId = null;
            this.tempPixels = null;
            this.invertedThisStroke = new Set();
            this.lastX = null;
            this.lastY = null;
            this.pendingCoord = null;
            this.drawFrame = null;
            this.strokeChanged = false;

            this.onPointerDown = (e) => {
                if (e.button !== 0 || this.isDrawing) return;

                e.preventDefault();

                this.isDrawing = true;
                this.activePointerId = e.pointerId;
                this.tempPixels = this.pixels.map(row => [...row]);
                this.invertedThisStroke.clear();
                this.strokeChanged = false;

                this.canvas.setPointerCapture(e.pointerId);

                const coord = this.getPixelIndex(e.clientX, e.clientY);
                if (!coord) return;

                this.lastX = coord.col;
                this.lastY = coord.row;
                this.invertPixelTemp(coord.row, coord.col);
            };

            this.onPointerMove = (e) => {
                if (!this.isDrawing || e.pointerId !== this.activePointerId) return;

                e.preventDefault();

                const coord = this.getPixelIndex(e.clientX, e.clientY);
                if (!coord) return;

                this.pendingCoord = coord;

                if (this.drawFrame === null) {
                    this.drawFrame = requestAnimationFrame(() => {
                        this.drawFrame = null;
                        this.flushPendingDraw();
                    });
                }
            };

            this.onPointerUp = (e) => {
                if (e.pointerId === this.activePointerId) {
                    this.finishStroke();
                }
            };

            this.onPointerCancel = (e) => {
                if (e.pointerId === this.activePointerId) {
                    this.finishStroke();
                }
            };

            this.onLostPointerCapture = () => {
                this.finishStroke();
            };

            this.onKeyDown = (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                    e.preventDefault();
                    this.undo();
                } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
                    e.preventDefault();
                    this.redo();
                }
            };

            this.canvas.addEventListener('pointerdown', this.onPointerDown);
            this.canvas.addEventListener('pointermove', this.onPointerMove);
            this.canvas.addEventListener('pointerup', this.onPointerUp);
            this.canvas.addEventListener('pointercancel', this.onPointerCancel);
            this.canvas.addEventListener('lostpointercapture', this.onLostPointerCapture);
            window.addEventListener('keydown', this.onKeyDown);

            this.render();
        }

        flushPendingDraw() {
            if (!this.isDrawing || !this.tempPixels || !this.pendingCoord) return;

            const coord = this.pendingCoord;
            this.pendingCoord = null;

            if (coord.col === this.lastX && coord.row === this.lastY) return;

            this.bresenhamTemp(this.lastY, this.lastX, coord.row, coord.col);
            this.lastX = coord.col;
            this.lastY = coord.row;
        }

        finishStroke() {
            if (!this.isDrawing) return;

            if (this.drawFrame !== null) {
                cancelAnimationFrame(this.drawFrame);
                this.drawFrame = null;
            }

            this.flushPendingDraw();

            if (this.tempPixels && this.strokeChanged) {
                this.pixels = this.tempPixels;
                this.saveToHistory();
            }

            this.isDrawing = false;
            this.activePointerId = null;
            this.tempPixels = null;
            this.pendingCoord = null;
            this.invertedThisStroke.clear();
            this.lastX = null;
            this.lastY = null;
            this.strokeChanged = false;
        }

        bresenhamTemp(y0, x0, y1, x1) {
            let dx = Math.abs(x1 - x0);
            let dy = Math.abs(y1 - y0);
            const sx = x0 < x1 ? 1 : -1;
            const sy = y0 < y1 ? 1 : -1;
            let err = dx - dy;

            while (true) {
                this.invertPixelTemp(y0, x0);

                if (x0 === x1 && y0 === y1) break;

                const e2 = err * 2;

                if (e2 > -dy) {
                    err -= dy;
                    x0 += sx;
                }

                if (e2 < dx) {
                    err += dx;
                    y0 += sy;
                }
            }
        }

        getPixelIndex(clientX, clientY) {
            const rect = this.canvas.getBoundingClientRect();
            const scaleX = this.canvas.width / rect.width;
            const scaleY = this.canvas.height / rect.height;
            const x = (clientX - rect.left) * scaleX - this.bw;
            const y = (clientY - rect.top) * scaleY - this.bw;
            const col = Math.floor(x / this.ps);
            const row = Math.floor(y / this.ps);

            if (row >= 0 && row < this.h && col >= 0 && col < this.w) {
                return { row, col };
            }

            return null;
        }

        invertPixelTemp(row, col) {
            this.invertSinglePixelTemp(row, col);

            if (this.mh) {
                const mirroredCol = this.w - 1 - col;

                if (mirroredCol !== col) {
                    this.invertSinglePixelTemp(row, mirroredCol);
                }
            }
        }

        invertSinglePixelTemp(row, col) {
            if (!this.tempPixels) return;

            const key = `${row},${col}`;

            if (this.invertedThisStroke.has(key)) return;

            this.invertedThisStroke.add(key);
            this.tempPixels[row][col] =
                this.tempPixels[row][col] === this.bg ? this.fg : this.bg;

            this.strokeChanged = true;
            this.drawPixelTemp(row, col);
        }

        drawPixelTemp(row, col) {
            this.ctx.fillStyle = this.tempPixels[row][col];
            this.ctx.fillRect(
                this.bw + col * this.ps,
                this.bw + row * this.ps,
                this.ps,
                this.ps
            );
        }

        render() {
            this.ctx.fillStyle = this.bg;
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

            for (let row = 0; row < this.h; row++) {
                for (let col = 0; col < this.w; col++) {
                    this.ctx.fillStyle = this.pixels[row][col];
                    this.ctx.fillRect(
                        this.bw + col * this.ps,
                        this.bw + row * this.ps,
                        this.ps,
                        this.ps
                    );
                }
            }
        }

        saveToHistory() {
            this.history = this.history.slice(0, this.historyIndex + 1);
            this.history.push(this.pixels.map(row => [...row]));
            this.historyIndex++;

            if (this.history.length > 50) {
                this.history.shift();
                this.historyIndex--;
            }
        }

        undo() {
            if (this.historyIndex <= 0) return;

            this.historyIndex--;
            this.pixels = this.history[this.historyIndex].map(row => [...row]);
            this.render();
        }

        redo() {
            if (this.historyIndex >= this.history.length - 1) return;

            this.historyIndex++;
            this.pixels = this.history[this.historyIndex].map(row => [...row]);
            this.render();
        }

        clear() {
            const clearedPixels = Array.from(
                { length: this.h },
                () => Array(this.w).fill(this.bg)
            );

            if (JSON.stringify(clearedPixels) === JSON.stringify(this.pixels)) return;

            this.pixels = clearedPixels;
            this.render();
            this.saveToHistory();
        }

        destroy() {
            if (this.drawFrame !== null) {
                cancelAnimationFrame(this.drawFrame);
            }

            this.canvas.removeEventListener('pointerdown', this.onPointerDown);
            this.canvas.removeEventListener('pointermove', this.onPointerMove);
            this.canvas.removeEventListener('pointerup', this.onPointerUp);
            this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
            this.canvas.removeEventListener('lostpointercapture', this.onLostPointerCapture);
            window.removeEventListener('keydown', this.onKeyDown);

            if (this.canvas.parentNode) {
                this.canvas.parentNode.removeChild(this.canvas);
            }
        }

        setForegroundColor(color) {
            this.fg = toHex(color);
        }

    }

    return {
        create: (canvas, options = {}) => {
            if (!canvas || !(canvas instanceof HTMLCanvasElement)) {
                throw new Error('valid canvas required');
            }

            const width = Math.max(1, Math.min(256, options.width || 32));
            const height = Math.max(1, Math.min(256, options.height || 32));
            const pixelSize = Math.max(1, Math.min(256, options.pixelSize || 16));
            const borderWidth = Math.max(0, Math.min(256, options.borderWidth || 0));
            const canvasWidth = width * pixelSize + borderWidth * 2;
            const canvasHeight = height * pixelSize + borderWidth * 2;

            if (canvasWidth > MAX_CANVAS_SIZE || canvasHeight > MAX_CANVAS_SIZE) {
                throw new RangeError(
                    `Canvas dimensions must not exceed ${MAX_CANVAS_SIZE}px.`
                );
            }

            return new BitmapEditorInstance(canvas, {
                width,
                height,
                pixelSize,
                borderWidth,
                backgroundColor: options.backgroundColor || '#FFFFFF',
                foregroundColor: options.foregroundColor || '#000000',
                mirrorHorizontal: Boolean(options.mirrorHorizontal),
            });
        }
    };
})();
