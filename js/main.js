'use strict';

/**
 * GitHub Identicon Explorer
 * -------------------------
 * Lets the user look up a GitHub user's auto-generated identicon by id or
 * username, draw/edit a 5x5 identicon pattern by hand, and brute-force
 * search a range of user ids for one whose identicon matches a given
 * pattern and/or color (delegated to Web Workers for speed).
 *
 * External globals this file depends on (loaded elsewhere on the page):
 *   - md5(str)                     MD5 hashing
 *   - hsl2rgb(h, s, l)              HSL -> [r, g, b] (0..1 floats)
 *   - Identicon(hash, options)      GitHub-style identicon renderer
 *   - BitmapEditor.create(...)      5x5 pixel-grid editor bound to canvas
 */

/* ============================================================
 * Config
 * ============================================================ */

let editor = null;
let defaultTitle = null;

let hashChangeTimer = null;
let autoFetchTimer = null;
let lastFetchTime = null;

const HASH_CHANGE_DEBOUNCE_MS = 250;
const AUTO_FETCH_DEBOUNCE_MS = 1000;
const SELECT_FETCH_DEBOUNCE_MS = 1000;

const COLOR_MATCH_DELTA_THRESHOLD = 3; // max summed |dr|+|dg|+|db| to accept

const GITHUB_USER_ESTIMATE = {
  date: new Date('2026-08-01'),
  count: 312018370,
  growthPerYear: 50000000,
};

const GRID_SIZE = 5;
const CELL_SIZE = 70;
const BORDER_WIDTH = 35;

// Layout of the 32 hex nibbles GitHub's identicon algorithm derives from
// an md5 hash: nibbles 0-24 encode the 5x5 (mirrored) bitmap, nibbles
// 25-31 encode an HLS color.
const HASH_NIBBLES = {
  HUE_HIGH: 25,
  HUE_MID: 26,
  HUE_LOW: 27,
  SAT_HIGH: 28,
  SAT_LOW: 29,
  LIGHT_HIGH: 30,
  LIGHT_LOW: 31,
};

// Empirically relaxed mask for color-nibble matching: rgb<->hls rounding
// means we can only reliably pin down the hue nibbles exactly.
const RELAXED_COLOR_MASK = '1111111111111110000000000fc00000';

/* ============================================================
 * Color utilities
 * ============================================================ */

const ColorUtils = {
  hexToRgb(hex) {
    return {
      r: parseInt(hex[1] + hex[2], 16),
      g: parseInt(hex[3] + hex[4], 16),
      b: parseInt(hex[5] + hex[6], 16),
    };
  },

  rgbToHex(r, g, b) {
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  },

  rgbToHls(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;

    if (d === 0) return { h: 0, l, s: 0 };

    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;

    return { h: h / 6, l, s };
  },

  isEqual(a, b) {
    return a.r === b.r && a.g === b.g && a.b === b.b;
  },

  delta(a, b) {
    return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
  },
};

/* ============================================================
 * Identicon <-> hash encoding/decoding
 *
 * GitHub identicons derive their bitmap + color from specific nibbles of
 * an md5 hash. These helpers convert between a hash and the color it
 * encodes, and between a 5x5 bitmap + target color and a hash/mask pair
 * suitable for brute-force searching.
 * ============================================================ */

const IdenticonCodec = {
  /** Decode the RGB color encoded in nibbles 25-31 of an md5 hash. */
  colorFromHash(hash) {
    const nibbles = this._hexToNibbles(hash);
    const h = ((nibbles[HASH_NIBBLES.HUE_HIGH] << 8) |
      (nibbles[HASH_NIBBLES.HUE_MID] << 4) |
      nibbles[HASH_NIBBLES.HUE_LOW]) / (16 * 256);
    const l = (960 - ((nibbles[HASH_NIBBLES.LIGHT_HIGH] << 4) | nibbles[HASH_NIBBLES.LIGHT_LOW])) / (5 * 256);
    const s = (832 - ((nibbles[HASH_NIBBLES.SAT_HIGH] << 4) | nibbles[HASH_NIBBLES.SAT_LOW])) / (5 * 256);

    const [r, g, b] = hsl2rgb(h, s, l).map((x) => Math.round(x * 255));
    return { r, g, b };
  },

  /** Encode an already-computed HLS triple (as GitHub packs it) into nibbles. */
  _encodeHls(h, l, s) {
    return {
      h: Math.floor(h * 4096), // 12 bits
      l: 960 - Math.floor(l * 1280), // 8 bits
      s: 832 - Math.floor(s * 1280), // 8 bits
    };
  },

  /**
   * Build a (target, mask) hex-nibble pair describing an md5 hash that
   * would render as `grid` (a 5x5 0/1 matrix) using `targetColor`.
   * The mask marks which nibbles must match exactly.
   */
  buildTargetAndMask(grid, targetColor) {
    // Start from an all-"don't care" (f) hash, fill in the bitmap bits,
    // then overlay the color nibbles.
    let target = 'fff00000000000000000000000000000';
    const targetNibbles = this._hexToNibbles(target);

    // The bitmap only stores columns 0-2 (columns 3-4 are the mirror of
    // 1-0), packed as 3 columns x 5 rows across the low 15 nibbles.
    for (let x = 0; x < 3; x++) {
      for (let y = 0; y < GRID_SIZE; y++) {
        targetNibbles[(2 - x) * 5 + y] = grid[y][x] === 1 ? 0 : 0xf;
      }
    }

    const { h, l, s } = ColorUtils.rgbToHls(targetColor.r, targetColor.g, targetColor.b);
    const enc = this._encodeHls(h, l, s);

    targetNibbles[HASH_NIBBLES.HUE_HIGH] = (enc.h >> 8) & 0x0f;
    targetNibbles[HASH_NIBBLES.HUE_MID] = (enc.h >> 4) & 0x0f;
    targetNibbles[HASH_NIBBLES.HUE_LOW] = enc.h & 0x0f;
    targetNibbles[HASH_NIBBLES.SAT_HIGH] = (enc.s >> 4) & 0x0f;
    targetNibbles[HASH_NIBBLES.SAT_LOW] = enc.s & 0x0f;
    targetNibbles[HASH_NIBBLES.LIGHT_HIGH] = (enc.l >> 4) & 0x0f;
    targetNibbles[HASH_NIBBLES.LIGHT_LOW] = enc.l & 0x0f;

    target = this._nibblesToHex(targetNibbles);

    // NOTE: a fully strict color mask doesn't work reliably because of
    // rgb<->hls rounding error; RELAXED_COLOR_MASK matches only the hue
    // nibbles exactly, which in practice is enough to disambiguate.
    return [target, RELAXED_COLOR_MASK];
  },

  _hexToNibbles(hex) {
    return Array.from(hex).map((c) => parseInt(c, 16));
  },

  _nibblesToHex(nibbles) {
    return nibbles.map((n) => n.toString(16)).join('');
  },
};

/* ============================================================
 * GitHub API access
 * ============================================================ */

const GitHubApi = {
  async getUserIdByUsername(username) {
    const url = `https://api.github.com/users/${username}`;
    console.log('fetching', url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not fetch username (${res.status})`);
    const data = await res.json();
    console.log('fetched id', data.id);
    return data.id;
  },

  async getUsernameById(id) {
    let url = `https://api.github.com/user/${id}`;
    console.log('fetching', url);
    const res = await fetch(url);
    if (!res.ok) {
      const error = new Error(`Could not fetch user (${res.status})`);
      error.status = res.status;
      throw error;
    }
    const data = await res.json();
    console.log('fetched username', data.login);
    return data.login;
  },

  async _listUsersSince(sinceId) {
    const url = `https://api.github.com/users?since=${sinceId}&per_page=100`;
    console.log('fetching', url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    return res.json();
  },

  /**
   * Binary-search GitHub's user list for the current highest user id,
   * starting from a rough estimate that's extrapolated forward in time.
   */
  async findLargestUserId() {
    let low = GITHUB_USER_ESTIMATE.count;
    let high = Math.ceil(
      low +
        (GITHUB_USER_ESTIMATE.growthPerYear * (Date.now() - GITHUB_USER_ESTIMATE.date)) /
          (365.25 * 24 * 60 * 60 * 1000)
    );

    let users;

    // Grow `high` exponentially until we find a page that isn't full,
    // i.e. we've gone past the current max id.
    while ((users = await this._listUsersSince(high)).length === 100) {
      high += high - GITHUB_USER_ESTIMATE.count;
    }
    if (users.length) return users.at(-1);

    // Binary search the [low, high] gap down to a 100-id window.
    while (high - low > 100) {
      const mid = low + Math.floor((high - low) / 2);
      users = await this._listUsersSince(mid);
      if (!users.length) high = mid;
      else if (users.length < 100) return users.at(-1);
      else low = users.at(-1).id;
    }

    return (await this._listUsersSince(low)).at(-1);
  },
};

/* ============================================================
 * Brute-force search over a user id range, delegated to workers
 * ============================================================ */

const IdenticonSearch = {
  /** Keep only ids whose color is within COLOR_MATCH_DELTA_THRESHOLD of targetColor. */
  filterByColor(ids, targetColor) {
    const matches = [];
    for (const id of ids) {
      const color = IdenticonCodec.colorFromHash(md5(String(id)));
      const delta = ColorUtils.delta(color, targetColor);
      if (delta <= COLOR_MATCH_DELTA_THRESHOLD) {
        console.log('Color match!', id, color, targetColor, 'delta', delta);
        matches.push(id);
      }
    }

    if (matches.length > 0) return matches;

    console.log('no color matches, returning the whole bunch');
    return ids;
  },

  /**
   * Split [minId, maxId) across worker threads, each hunting for ids
   * whose md5 hash matches `target`/`mask`, then filter the combined
   * results by color.
   */
  run({ minId, maxId, target, mask, targetColor, minChunk = 8192, onProgress }) {
    if (maxId - minId < minChunk) {
      console.log(`chunk size cannot be smaller than ${minChunk}`);
      return Promise.resolve(null);
    }

    const numThreads = (navigator.hardwareConcurrency || 4) * 2;
    const chunkSize = Math.ceil((maxId - minId) / numThreads);
    const startTime = performance.now();

    console.log(`starting search, minId: ${minId}, maxId: ${maxId}, target: ${target}, mask: ${mask}`);

    let completedWorkers = 0;
    let matchCount = 0;
    let results = [];

    return new Promise((resolve) => {
      let threadsStarted = 0;

      for (let i = 0; i < numThreads; i++) {
        const start = minId + i * chunkSize;
        const end = Math.min(start + chunkSize, maxId);
        if (start >= maxId) break;

        threadsStarted++;
        const worker = new Worker('wasm/worker.js', { type: 'module' });

        worker.onmessage = (e) => {
          if (e.data.result?.length) {
            matchCount += e.data.result.length;
            results.push(...e.data.result);
          }

          completedWorkers++;
          worker.terminate();

          if (completedWorkers === threadsStarted) {
            const elapsed = performance.now() - startTime;
            const rate = Math.round((maxId / elapsed) * 1000);
            console.log(`Completed in ${elapsed.toFixed(2)} ms\nRate: ${rate} IDs/sec`);
            console.log('Total results', matchCount);

            results = this.filterByColor(results, targetColor);
            console.log(`Filtered by color, ${results.length} result(s).`);

            results.sort((a, b) => a - b);
            onProgress?.(results);
            resolve(results);
          }
        };

        worker.postMessage({ start, end, targetHex: target, maskHex: mask });
      }
    });
  },
};

/* ============================================================
 * UI: canvas / grid / editor wiring
 * ============================================================ */

const CanvasGrid = {
  draw(grid, color) {
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    ctx.fillStyle = 'rgb(240, 240, 240)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = `rgb(${color.r},${color.g},${color.b})`;

    for (let x = 0; x < GRID_SIZE; x++) {
      for (let y = 0; y < GRID_SIZE; y++) {
        if (grid[y][x] === 1) {
          ctx.fillRect(BORDER_WIDTH + x * CELL_SIZE, BORDER_WIDTH + y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
        }
      }
    }
  },

  /** Read the current canvas back into a 0/1 grid + the color used, by sampling cell centers. */
  read() {
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const colors = [];
    for (let row = 0; row < GRID_SIZE; row++) {
      const rowColors = [];
      for (let col = 0; col < GRID_SIZE; col++) {
        const px = col * CELL_SIZE + CELL_SIZE / 2;
        const py = row * CELL_SIZE + CELL_SIZE / 2;
        const pixel = ctx.getImageData(BORDER_WIDTH + px, BORDER_WIDTH + py, 1, 1).data;
        rowColors.push({ r: pixel[0], g: pixel[1], b: pixel[2] });
      }
      colors.push(rowColors);
    }

    let detectedColor = null;
    const grid = colors.map((row) =>
      row.map((color) => {
        if (color.r !== 240) detectedColor = color;
        const brightness = (color.r + color.g + color.b) / 3;
        return brightness === 240 || brightness === 255 ? 0 : 1;
      })
    );

    return { grid, detectedColor };
  },
};

/* ============================================================
 * App: DOM wiring & top-level control flow
 *
 * Public functions are attached to `window` because the page's markup
 * invokes them by name (via data-fn/data-submit attributes and inline
 * event handlers).
 * ============================================================ */

function resetFields() {
  document.getElementById('username').value = '';
  document.getElementById('userid').value = '';
  document.getElementById('hash').value = '';
  updateLink('');
}

function resetUsername(preserveHash) {
  document.getElementById('username').value = '';
  document.getElementById('username').placeholder = 'Username';
  if (!preserveHash) location.hash = '';
  document.getElementById('select').selectedIndex = 0;
  updateLink();
}

function updateLink(username) {
  const linkEl = document.getElementById('link');
  linkEl.innerHTML = username
    ? `<a href="https://github.com/${username}/" target="_blank">https://github.com/${username}/</a>`
    : 'Unknown Username';
}

/** Re-render the identicon for the current #userid value and sync the URL hash + title. */
function generate() {
  const id = document.getElementById('userid').value;
  const hash = md5(String(id));
  document.getElementById('hash').value = hash;
  renderIdenticonFromHash(hash);
}

function renderIdenticonFromHash(hash) {
  const color = IdenticonCodec.colorFromHash(hash);

  const options = {
    foreground: [color.r, color.g, color.b],
    margin: 0.0788,
    size: 420,
    format: 'png',
  };

  const data = new Identicon(hash, options).toString();
  const img = new Image();
  img.onload = () => {
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
    syncColorAndTargetFromCanvas();
  };
  img.src = 'data:image/png;base64,' + data;
}

/**
 * Read the canvas grid + color, reflect them into the #color/#target/#mask
 * fields, and (unless `colorOnly`) redraw the canvas from that grid.
 */
function syncColorAndTargetFromCanvas(colorOnly = false) {
  const { grid, detectedColor } = CanvasGrid.read();

  const colorInputValue = document.getElementById('color').value;
  let targetColor = detectedColor || ColorUtils.hexToRgb(colorInputValue);
  if (colorOnly) targetColor = ColorUtils.hexToRgb(colorInputValue);

  const hex = ColorUtils.rgbToHex(targetColor.r, targetColor.g, targetColor.b);
  document.getElementById('color').value = hex;
  editor.setForegroundColor(hex);

  if (!colorOnly) {
    CanvasGrid.draw(grid, targetColor);
  }

  const [target, mask] = IdenticonCodec.buildTargetAndMask(grid, targetColor);
  document.getElementById('target').value = target;
  document.getElementById('mask').value = mask;

  return { grid, targetColor };
}

function updateTarget() {
  syncColorAndTargetFromCanvas(true);
}

function uploadImage() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.style.display = 'none';

  input.onchange = function () {
    const file = this.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.getElementById('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        syncColorAndTargetFromCanvas();
        resetFields();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
    this.remove();
  };

  document.body.appendChild(input);
  input.click();
}

async function searchImage() {
  const target = document.getElementById('target').value;
  const mask = document.getElementById('mask').value;
  const targetColor = ColorUtils.hexToRgb(document.getElementById('color').value);
  const minId = parseInt(document.getElementById('minId').value, 10);
  const maxId = parseInt(document.getElementById('maxId').value, 10);

  const select = document.getElementById('select');
  select.innerHTML = '<option>Searching...</option>';

  const results = await IdenticonSearch.run({
    minId,
    maxId,
    target,
    mask,
    targetColor,
  });

  if (results === null) return; // range too small, message already logged

  for (const id of results.slice(0, 500)) {
    const option = document.createElement('option');
    option.value = String(id);
    option.text = String(id);
    select.appendChild(option);
  }

  select.options[0].text = `${select.options.length - 1} result(s)`;
  select.options[0].value = '';
  if (select.options.length > 1) {
    select.selectedIndex = 1;
    let event = new Event('change', { bubbles: true });
    event.doFetch = true;
    select.dispatchEvent(event);
  }
}

async function fetchID() {
  const username = document.getElementById('username').value;
  try {
    const id = await GitHubApi.getUserIdByUsername(username);
    document.getElementById('userid').value = id;
    generate();
    updateLink(username);
  } catch (e) {
    alert(e.message);
  }
}

async function fetchUsername() {
  const now = Date.now();
  if (now - lastFetchTime < SELECT_FETCH_DEBOUNCE_MS) return { success: false, error: 'throttled', status: 429 };
  lastFetchTime = now;

  const usernameEl = document.getElementById('username');
  const useridEl = document.getElementById('userid');
  const id = useridEl.value;

  try {
    const username = await GitHubApi.getUsernameById(id);
    usernameEl.value = username;
    useridEl.value = id;
    generate();
    updateLink(username);
    clearTimeout(hashChangeTimer);
    window.location.hash = username;
    document.title = `${username} - ${defaultTitle}`;
    return { success: true, username, status: 200 };
  } catch (e) {
    let status = e.status || e.response?.status || e.statusCode || e.code || 500;
    usernameEl.placeholder = `Username not found (${status})`;
    return { success: false, error: e.message, status };
  }
}

async function loadUserAndGenerate(username) {
  const usernameEl = document.getElementById('username');
  const useridEl = document.getElementById('userid');
  try {
    const id = await GitHubApi.getUserIdByUsername(username);
    usernameEl.value = username;
    useridEl.value = id;
    generate();
    updateLink(username);
  } catch (e) {
    alert(e.message);
  }
}

function enforceRange(input) {
  const min = parseFloat(input.min);
  const max = parseFloat(input.max);
  const value = parseFloat(input.value);
  if (!isNaN(value)) {
    if (value < min) input.value = min;
    if (value > max) input.value = max;
  }
}

async function random(e) {
  e.preventDefault();
  resetUsername();
  const maxId = parseInt(document.getElementById('maxId').value, 10);
  const useridEl = document.getElementById('userid');
  useridEl.value = Math.floor(Math.random() * maxId);
  useridEl.select();
  onUserIdChangedDebounced();
}

function onUserIdChangedDebounced() {
  const id = document.getElementById('userid').value;
  window.location.hash = id;
  document.title = `${id} - ${defaultTitle}`;
  generate();

  clearTimeout(autoFetchTimer);
  autoFetchTimer = setTimeout(fetchUsername, AUTO_FETCH_DEBOUNCE_MS); // comment out, if API limit is too low
}

function onUserIdInput() {
  clearTimeout(autoFetchTimer);
  clearTimeout(hashChangeTimer);
  hashChangeTimer = setTimeout(onUserIdChangedDebounced, HASH_CHANGE_DEBOUNCE_MS);
}

/* ------------------------------------------------------------
 * Bootstrap
 * ------------------------------------------------------------ */

window.onload = function () {
  const usernameEl = document.getElementById('username');
  const useridEl = document.getElementById('userid');
  const selectEl = document.getElementById('select');

  selectEl.onchange = (e) => {
    const option = e.target.options[e.target.selectedIndex];
    const text = option.text;
    const id = e.target.value;

    let hasText = text && id && text !== id;
    let validText = text && !new RegExp(' [([]').test(text);

    if (hasText && validText) {
      usernameEl.value = text;
      location.hash = text;
      useridEl.value = id;
      useridEl.select();
      generate();
      updateLink(text);

    } else if (id) {
      usernameEl.value = '';
      location.hash = id;
      useridEl.value = id;
      option.title = id;
      generate();
      updateLink();

      if (validText) { // && e.doFetch
        (async () => {
          const result = await fetchUsername();
          if (result && result.success) {
            option.text = usernameEl.value = result.username;
          } else if (result.status != 429) {
            option.text = `${id} [${result.status}]`;
          }
        })();
      }

    }
  };

  ['input', 'keyup', 'change'].forEach((evt) => useridEl.addEventListener(evt, onUserIdInput, false));
  useridEl.addEventListener('input', () => resetUsername());

  usernameEl.addEventListener('input', () => {
    selectEl.selectedIndex = 0;
    updateLink();
  });

  useridEl.select();

  let lastHash = '';
  function handleHashChange() {
    if (location.hash.length > 1 && lastHash !== location.hash) {
      lastHash = location.hash;
      const str = location.hash.slice(1);
      if (/^\d+$/.test(str)) {
        resetUsername(true);
        document.getElementById('userid').value = str;
        generate();
      } else {
        loadUserAndGenerate(str);
      }
    } else {
      generate();
    }
  }
  handleHashChange();
  // NOTE: intentionally not listening for 'hashchange' - see original comment;
  // hash updates are already driven from within this file.

  editor = BitmapEditor.create(document.getElementById('canvas'), {
    width: GRID_SIZE,
    height: GRID_SIZE,
    pixelSize: CELL_SIZE,
    backgroundColor: '#f0f0f0',
    foregroundColor: '#9FA9DD',
    mirrorHorizontal: false,
    borderWidth: BORDER_WIDTH,
  });

  document.getElementById('color').addEventListener('input', (e) => {
    editor.setForegroundColor(e.target.value);
  });

  document.getElementById('canvas').addEventListener('click', resetFields);
  document.getElementById('canvas').addEventListener('click', updateTarget);

  const estimatedMaxId = Math.ceil(
    GITHUB_USER_ESTIMATE.count +
      (GITHUB_USER_ESTIMATE.growthPerYear * (Date.now() - GITHUB_USER_ESTIMATE.date)) /
        (365.25 * 24 * 60 * 60 * 1000)
  );
  document.getElementById('maxId').value =
    Math.ceil(estimatedMaxId / GITHUB_USER_ESTIMATE.growthPerYear) * GITHUB_USER_ESTIMATE.growthPerYear;

  document.getElementById('getMinId').addEventListener('click', () => {
    document.getElementById('minId').value = 0;
  });

  document.getElementById('getMaxId').addEventListener('click', () => {
    GitHubApi.findLargestUserId().then((user) => {
      console.log('largest user found', user.id, user.login);
      document.getElementById('maxId').value = user.id;
    });
  });

  // Buttons/inputs declare which handler to run via data-fn/data-submit,
  // e.g. <button data-fn="fetchID">. Dispatch by name lookup (no eval).
  // Keys here must match the data-fn/data-submit values in the HTML.
  const publicHandlers = {
    fetchID,
    fetchUsername,
    uploadImage,
    searchImage,
    random,
  };

  document.querySelectorAll('[data-fn]').forEach((el) => {
    el.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const handler = publicHandlers[el.dataset.fn];
      el.disabled = true;
      try {
        if (handler) await handler(e);
        else console.warn('Function not found', el.dataset.fn);
      } finally {
        el.disabled = false;
      }
      return false;
    };
  });

  document.querySelectorAll('[data-submit]').forEach((el) => {
    el.onkeydown = (e) => {
      if (e.key !== 'Enter') return true;
      const handler = publicHandlers[el.dataset.submit];
      if (handler) handler(e);
      else console.warn('Function not found', el.dataset.submit);
      return false;
    };
  });

  defaultTitle = document.title;
};

// Exposed for any inline HTML handlers (e.g. oninput="enforceRange(this)")
// or console debugging.
window.enforceRange = enforceRange;
window.md5hex = (str) => md5(str);
