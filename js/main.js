function get_color(id) {
  const hash = md5(String(id));
  const m = hash.split('').map(c => parseInt(c,16));
  const H = (m[25]<<8 | m[26]<<4 | m[27]) / (16*256);
  const L = (960 - (m[30]<<4 | m[31])) / (5*256);
  const S = (832 - (m[28]<<4 | m[29])) / (5*256);
  const rgb = hsl2rgb(H, S, L).map(x => Math.round(x*255));
  return {r:rgb[0], g:rgb[1], b:rgb[2]};
}

const isEqualColor = (a, b) => a.r === b.r && a.g === b.g && a.b === b.b;

function filter_by_color(results, targetColor) {
  return results.filter(id => isEqualColor(get_color(id),targetColor));
}

function find_targets(targetHex, maskHex, targetColor) {
  const maxId = 300_000_000; //300 million users now

  const numThreads = (navigator.hardwareConcurrency || 4) * 2; // 2x oversubscribing
  const chunkSize = Math.ceil(maxId / numThreads);
  
  let completedWorkers = 0;
  const startTime = performance.now();

  console.log(`starting search, maxId: ${maxId}, target: ${targetHex}, mask: ${maskHex}`);

  const select = document.getElementById('select');
  select.innerHTML = '<option>Searching...</option>';

  count = 0;
  results = [];

  for (let i = 0; i < numThreads; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, maxId);
      if (start >= maxId) break;

      const worker = new Worker('wasm/worker.js', { type: 'module' });
      
      worker.onmessage = (e) => {

          if (e.data.result?.length) {
              //output.appendChild(document.createTextNode(e.data.result.join('\n') + '\n'));
              //console.log(e.data.result.join('\n'));
              //e.data.result.map(x=>results.push(String(x)));
              //console.log(`Collected ${results.length} results...`);
              //console.log(`Collected ${e.data.result.length} results...`);

              count += e.data.result.length;
              e.data.result.map(x=>results.push(x));
          }

          completedWorkers++;
          worker.terminate();

          if (completedWorkers === numThreads) {
              const elapsed = performance.now() - startTime;
              const rate = Math.round((maxId / elapsed) * 1000);

              const stats = `Completed in ${elapsed.toFixed(2)} ms\nRate: ${rate} IDs/sec\n`;
              //output.appendChild(document.createTextNode(stats));

              console.log(stats);

              console.log('Total results', count);

              results = filter_by_color(results, targetColor);

              for (const id of results.sort((a, b) => a - b).slice(0, 500)) {
                  const text=String(id);
                  const option = document.createElement('option');
                  option.value = text;
                  option.text = text;
                  select.appendChild(option);
              }

              select.options[0].text = `${select.options.length-1} results`;
              select.options[0].value = '';
              if (select.options.length>1) {
                select.selectedIndex = 1;
                select.dispatchEvent(new Event('change', { bubbles: true }));
              }
          }
      };

      worker.postMessage({ start, end, targetHex, maskHex });
  }

}

function processImage(img) {
  const canvas = document.createElement('canvas');
  canvas.width = 350;
  canvas.height = 350;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  
  // Draw image at 350x350 (no border)
  ctx.drawImage(img, 0, 0, 350, 350);
  
  // Read 5x5 grid, each cell 70px
  const gridSize = 5;
  const cellSize = 70;
  const colors = [];
  
  for (let row = 0; row < gridSize; row++) {
    const rowColors = [];
    for (let col = 0; col < gridSize; col++) {
      const px = col * cellSize + cellSize/2;
      const py = row * cellSize + cellSize/2;
      const pixel = ctx.getImageData(px, py, 1, 1).data;
      rowColors.push({
        r: pixel[0],
        g: pixel[1],
        b: pixel[2]
      });
    }
    colors.push(rowColors);
  }
  console.log(colors);

  let targetColor = 255;

  // Convert to text grid
  const grid = colors.map(row => 
    row.map(color => {
      const brightness = (color.r + color.g + color.b) / 3;
      if (color.r!=240) targetColor = color;
      return (brightness == 240 || brightness == 255) ? 0 : 1;
    }).join('')
  );

  console.log(grid.join('\n'));

  target='fff00000000000000000000000000000';
    mask='11111111111111100000000000000000';

  // set lower 15 nibbles to bits

  let targetArr = [...target];

  for (let x=0; x<3; x++) {
    for (let y=0; y<5; y++) {
        targetArr[(2-x)*5+y] = grid[y][x]==1 ? '0':'f';
    }
  }

  target = targetArr.join('');

  //The top 6 set an HLS color (12 bits hue, 8 lightness, 8 saturation)

  function rgbToHls(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const M = Math.max(r, g, b), m = Math.min(r, g, b);
      const l = (M + m) / 2;
      const d = M - m;
      if (d === 0) return [0, l, 0];
      const s = l > 0.5 ? d / (2 - M - m) : d / (M + m);
      let h = M === r ? (g - b) / d + (g < b ? 6 : 0) :
              M === g ? (b - r) / d + 2 :
              (r - g) / d + 4;
      return [h / 6, l, s];
  }

  console.log('target color', targetColor);

  [h,l,s] = rgbToHls(targetColor.r, targetColor.g, targetColor.b);

  function encode_hls(h,l,s) {
    const h_enc = Math.floor(h * 4096);        // 0.639892578125 * 4096 = 2621
    const l_enc = 960 - Math.floor(l * 1280); // 960 - floor(0.74453125 * 1280) = 960 - 953 = 7
    const s_enc = 832 - Math.floor(s * 1280); // 832 - floor(0.4796875 * 1280) = 832 - 614 = 218
    return [h_enc, l_enc, s_enc];
  }

  [h,l,s] = encode_hls(h,l,s);


  function hexToNibbles(hex) {
      return Array.from(hex).map(c => parseInt(c, 16));
  }

  function nibblesToHex(nibbles) {
      return nibbles.map(n => n.toString(16)).join('');
  }

  let nibbles = hexToNibbles(target);

  nibbles[25] = (h >> 8) & 0x0F;     // High nibble (bits 8-11)
  nibbles[26] = (h >> 4) & 0x0F;     // Middle nibble (bits 4-7)
  nibbles[27] = h & 0x0F;            // Low nibble (bits 0-3)
        
  // s is 8 bits -> 2 nibbles at positions 28, 29
  nibbles[28] = (s >> 4) & 0x0F;     // High nibble
  nibbles[29] = s & 0x0F;            // Low nibble

  // l is 8 bits -> 2 nibbles at positions 30, 31
  nibbles[30] = (l >> 4) & 0x0F;     // High nibble
  nibbles[31] = l & 0x0F;            // Low nibble

  target = nibblesToHex(nibbles);

  console.log('target', target);

  // mask should be relaxed because of rgb rounding errors
  // looks like it doesn't work reliably, need specific bruteforcer
  // that will bruteforce all colors and filter by rgb results
  //mask='1111111111111110000000000fc0c0c0';

  mask='1111111111111110000000000fc00000'; // this works better (for jasonlong and stewardlord)

  find_targets(target, mask, targetColor);
}

function upload_image() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.style.display = 'none';

  input.onchange = function() {
    const file = this.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(e) {
      const img = new Image();
      img.onload = function() {
        processImage(img);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
    this.remove();
  };
  
  document.body.appendChild(input);
  input.click();
}

async function getId(username) {
  const url = `https://api.github.com/users/${username}`;
  console.log('fetching id', url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not fetch Username (${r.status})`);
  const j = await r.json();
  console.log('Fetched Username', username, 'id', j.id);
  return j.id;
}

async function getName(id) {
  const url = `https://api.github.com/user/${id}`;
  console.log('fetching username', url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not fetch user (${r.status})`);
  const j = await r.json();
  console.log('fetched id', id, 'name', j.login);
  return j.login;
}

function md5hex(str) {
  return md5(str);
}

let TIMEOUT = 250;
let timeout = null;

function onChange(e) {
  //console.log('onChange', e);
  clearTimeout(timeout);
  timeout = setTimeout(generateOnChange, TIMEOUT);
}

function generateOnChange() {
  location.hash = document.getElementById('userid').value;
  generate();
}

function generate() {
  const id = document.getElementById('userid').value;

  //let id = 852547;

  const hash = md5(String(id));

  document.getElementById('hash').textContent = hash;

  //console.log(hash, hsl2rgb);

  const m = hash.split('').map(c => parseInt(c,16));
  const H = (m[25]<<8 | m[26]<<4 | m[27]) / (16*256);
  const L = (960 - (m[30]<<4 | m[31])) / (5*256);
  const S = (832 - (m[28]<<4 | m[29])) / (5*256);
  const rgb = hsl2rgb(H, S, L).map(x => Math.round(x*255));
  const color = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;

  var options = {
    foreground: rgb,
    margin: 0.0788,
    size: 420,
    format: 'png'
  };

  var data = new Identicon(hash, options).toString();

  var img = document.getElementById('image')

  img.src = 'data:image/png;base64,' + data;

  //document.getElementById('lookup').style.visibility = 'visible';
  //document.getElementById('lookup').href = `https://api.github.com/user/${id}`;

  document.getElementById('getName').disabled = document.getElementById('username').value!='';
}

async function updateLink(username) {
  if (username) {
    document.getElementById('link').innerHTML = `<a href="https://github.com/${username}/" target=_blank>https://github.com/${username}/</a>`;
  } else {
    document.getElementById('link').innerHTML = `Unknown Username`;
  }
}

async function loadUserName() {
  let uname_ctrl = document.getElementById('username');
  let uid_ctrl = document.getElementById('userid');
  const id = uid_ctrl.value;
  console.log('trying to fetch', id);
  try {
    const username = await getName(id);
    uname_ctrl.value = username;
    uid_ctrl.value = id;
    generate();
    updateLink(username);
    clearTimeout(timeout);
    location.hash = username;
  } catch (e) {
    alert(e.message);
  }
}

async function loadUserAndGenerate(username) {
  let uname_ctrl = document.getElementById('username');
  let uid_ctrl = document.getElementById('userid');
  try {
    const id = await getId(username);
    uname_ctrl.value = username;
    uid_ctrl.value = id;
    generate();
    updateLink(username);
  } catch (e) {
    alert(e.message);
  }
}

window.onload = function() {

  let uname_ctrl = document.getElementById('username');
  let uid_ctrl = document.getElementById('userid');
  let select_ctrl = document.getElementById('select');

  select_ctrl.onchange = (e)=> {
    let username = e.target.options[e.target.selectedIndex].text;
    let id = e.target.value;

    if (username && id && username!=id) {
      uname_ctrl.value = username;
      location.hash = username;
      uid_ctrl.value = id;
      uid_ctrl.select();
      document.getElementById('fetchBtn').disabled = true;
      generate();
      updateLink(username);
    } else if (id){
      //resetUsername();
      document.getElementById('username').value = '';
      location.hash = id;
      uid_ctrl.value = id;
      //uid_ctrl.select();
      //select_ctrl.select();

      document.getElementById('fetchBtn').disabled = true;
      generate();
      updateLink();
    }
  }

  function resetUsername(preserveHash) {
    document.getElementById('username').value = '';
    document.getElementById('fetchBtn').disabled = true;
    if (!preserveHash) location.hash = '';
    document.getElementById('select').selectedIndex = 0;
    updateLink();
  }

  document.getElementById('randomize').onclick = async e => {
    e.preventDefault();
    resetUsername();
    uid_ctrl.value = Math.floor(Math.random() * 150000000); // about 150 million users as of 2025
    uid_ctrl.select();
    generateOnChange();
  }

  document.getElementById('idForm').onsubmit = async e => {
    e.preventDefault();
    loadUserName();
  }

  document.getElementById('nameForm').onsubmit = async e => {
    e.preventDefault();
    try {
      document.getElementById('fetchBtn').disabled = true;
      let username = uname_ctrl.value.trim();
      location.hash = username;
      const id = await getId(username);
      uid_ctrl.value = id;
      uid_ctrl.select();
      generate();
      updateLink(username);
    } catch(e) {
      alert(e.message);
    }
  };

  'input keyup change'.split(' ').forEach(function(e){
    uid_ctrl.addEventListener(e, onChange, false);
  });

  uid_ctrl.addEventListener('input', resetUsername);

  uname_ctrl.addEventListener('input', function() {
    document.getElementById('fetchBtn').disabled = uname_ctrl.value.length==0;
    document.getElementById('select').selectedIndex = 0;
    updateLink();
  })

  uid_ctrl.select();

  let lastHash = '';

  function hashChange() {
    if (location.hash.length > 1 && lastHash != location.hash) {
      lastHash = location.hash;
      const str = location.hash.slice(1);
      if (/^\d+$/.test(str)) {
        resetUsername(true);
        document.getElementById('userid').value = str;
        generate()
      } else {
        loadUserAndGenerate(str);
      }
    } else {
      generate();
    }
  }

  hashChange();

  //window.addEventListener('hashchange', hashChange); //breaks shit
};

