/**
 * Gerador de QR Code 100% Offline (Zero Dependências)
 * Gera SVG escaneável por qualquer câmera de celular (Android / iOS)
 * Suporta URLs locais (ex: http://192.168.1.15:3080) usando Byte Mode (ECC Level L)
 */

const GF256_EXP = new Uint8Array(512);
const GF256_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF256_EXP[i] = x;
    GF256_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF256_EXP[i] = GF256_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF256_EXP[GF256_LOG[a] + GF256_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF256_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const msg = new Uint8Array(data.length + ecLen);
  msg.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return msg.slice(data.length);
}

// Tabelas para versões 1 a 6 em nível L (1 bloco para V1..V5, 2 blocos para V6)
const VERSION_TABLE = [
  null,
  { version: 1, totalData: 19, ecPerBlock: 7, blocks: 1, align: [] },
  { version: 2, totalData: 34, ecPerBlock: 10, blocks: 1, align: [6, 18] },
  { version: 3, totalData: 55, ecPerBlock: 15, blocks: 1, align: [6, 22] },
  { version: 4, totalData: 80, ecPerBlock: 20, blocks: 1, align: [6, 26] },
  { version: 5, totalData: 108, ecPerBlock: 26, blocks: 1, align: [6, 30] },
  { version: 6, totalData: 136, ecPerBlock: 18, blocks: 2, align: [6, 34] }
];

function encodeData(text) {
  const bytes = Buffer.from(text, 'utf8');
  let spec = null;
  for (let v = 1; v <= 6; v++) {
    const s = VERSION_TABLE[v];
    if (bytes.length + 2 <= s.totalData) {
      spec = s;
      break;
    }
  }
  if (!spec) {
    throw new Error('Texto muito longo para o gerador QR local');
  }

  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >>> i) & 1);
    }
  };

  // Mode indicator: Byte mode (0100)
  pushBits(0b0100, 4);
  // Character count indicator (8 bits for V1-V9)
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);

  const maxBits = spec.totalData * 8;
  const term = Math.min(4, maxBits - bits.length);
  pushBits(0, term);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataBytes = new Uint8Array(spec.totalData);
  for (let i = 0; i < bits.length / 8; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j];
    dataBytes[i] = b;
  }
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  for (let i = bits.length / 8; i < spec.totalData; i++) {
    dataBytes[i] = padBytes[padIdx % 2];
    padIdx++;
  }

  // Divide into blocks if needed
  const dataBlocks = [];
  const ecBlocks = [];
  const blockSize = spec.totalData / spec.blocks;
  for (let b = 0; b < spec.blocks; b++) {
    const block = dataBytes.slice(b * blockSize, (b + 1) * blockSize);
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, spec.ecPerBlock));
  }

  const finalCodewords = [];
  for (let i = 0; i < blockSize; i++) {
    for (let b = 0; b < spec.blocks; b++) finalCodewords.push(dataBlocks[b][i]);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (let b = 0; b < spec.blocks; b++) finalCodewords.push(ecBlocks[b][i]);
  }

  return { spec, codewords: finalCodewords };
}

function buildMatrix(spec, codewords) {
  const size = spec.version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));
  const isFunc = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFunc = (r, c, val) => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      modules[r][c] = Boolean(val);
      isFunc[r][c] = true;
    }
  };

  const drawFinder = (r, c) => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const y = r + dy;
        const x = c + dx;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const inOuter = dy >= 0 && dy <= 6 && dx >= 0 && dx <= 6;
        const inWhite = dy >= 1 && dy <= 5 && dx >= 1 && dx <= 5;
        const inCenter = dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4;
        setFunc(y, x, inOuter && (!inWhite || inCenter));
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  const align = spec.align;
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) {
        continue;
      }
      const cr = align[i];
      const cc = align[j];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunc(cr + dy, cc + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Reserve format info areas + dark module
  for (let i = 0; i <= 8; i++) {
    if (!isFunc[8][i]) setFunc(8, i, false);
    if (!isFunc[i][8]) setFunc(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    if (!isFunc[8][size - 1 - i]) setFunc(8, size - 1 - i, false);
    if (!isFunc[size - 1 - i][8]) setFunc(size - 1 - i, 8, false);
  }
  setFunc(size - 8, 8, true);

  // Place data bits
  const allBits = [];
  for (const cw of codewords) {
    for (let i = 7; i >= 0; i--) allBits.push((cw >>> i) & 1);
  }

  let bitIdx = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - vert : vert;
        if (!isFunc[r][c]) {
          const bit = bitIdx < allBits.length ? Boolean(allBits[bitIdx++]) : false;
          // Apply mask 0: (r + c) % 2 === 0
          modules[r][c] = (r + c) % 2 === 0 ? !bit : bit;
        }
      }
    }
  }

  // Format information for ECC Level L (01) and Mask 0 (000) -> precomputed BCH bits = 0x77c4
  const formatBits = 0x77c4;
  const getBit = (val, i) => ((val >>> i) & 1) !== 0;

  for (let i = 0; i <= 5; i++) setFunc(8, i, getBit(formatBits, i));
  setFunc(8, 7, getBit(formatBits, 6));
  setFunc(8, 8, getBit(formatBits, 7));
  setFunc(7, 8, getBit(formatBits, 8));
  for (let i = 9; i < 15; i++) setFunc(14 - i, 8, getBit(formatBits, i));

  for (let i = 0; i < 8; i++) setFunc(8, size - 1 - i, getBit(formatBits, i));
  for (let i = 8; i < 15; i++) setFunc(size - 15 + i, 8, getBit(formatBits, i));
  setFunc(size - 8, 8, true);

  return modules;
}

function generateQRCodeSVG(text, margin = 3) {
  const { spec, codewords } = encodeData(text);
  const matrix = buildMatrix(spec, codewords);
  const size = matrix.length;
  const total = size + margin * 2;

  let path = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) {
        path += `M${c + margin},${r + margin}h1v1h-1z`;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" class="qr-svg">
    <rect width="100%" height="100%" fill="#ffffff" rx="1.5"/>
    <path d="${path}" fill="#0f172a"/>
  </svg>`;
}

module.exports = { generateQRCodeSVG };
