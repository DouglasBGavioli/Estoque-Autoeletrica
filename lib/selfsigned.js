/**
 * Gerador de Certificado TLS Autoassinado (X.509 v3) 100% Nativo em Node.js (node:crypto)
 * Permite rodar HTTPS local (ex: https://192.168.1.15:3443) sem precisar de OpenSSL externo,
 * liberando a câmera ao vivo (getUserMedia) nos navegadores de celular via Wi-Fi.
 */

const crypto = require('node:crypto');

function encodeLength(len) {
  if (len < 128) return Buffer.from([len]);
  const bytes = [];
  let temp = len;
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function asn1Tag(tag, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), encodeLength(buf.length), buf]);
}

function asn1Seq(...items) {
  return asn1Tag(0x30, Buffer.concat(items));
}

function asn1Set(...items) {
  return asn1Tag(0x31, Buffer.concat(items));
}

function asn1Int(numOrBuf) {
  let buf;
  if ( typeof numOrBuf === 'number' ) {
    const hex = numOrBuf.toString(16);
    buf = Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
  } else {
    buf = Buffer.from(numOrBuf);
  }
  if (buf[0] & 0x80) {
    buf = Buffer.concat([Buffer.from([0x00]), buf]);
  }
  return asn1Tag(0x02, buf);
}

function asn1BitString(buf) {
  return asn1Tag(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
}

function asn1OctetString(buf) {
  return asn1Tag(0x04, buf);
}

function asn1Oid(oidStr) {
  const parts = oidStr.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let val = parts[i];
    if (val === 0) {
      bytes.push(0);
      continue;
    }
    const sub = [];
    while (val > 0) {
      sub.unshift(val & 0x7f);
      val >>>= 7;
    }
    for (let j = 0; j < sub.length - 1; j++) sub[j] |= 0x80;
    bytes.push(...sub);
  }
  return asn1Tag(0x06, Buffer.from(bytes));
}

function asn1Utf8(str) {
  return asn1Tag(0x0c, Buffer.from(str, 'utf8'));
}

function asn1UtcTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const str =
    String(date.getUTCFullYear()).slice(-2) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z';
  return asn1Tag(0x17, Buffer.from(str, 'ascii'));
}

function buildName(cn) {
  return asn1Seq(
    asn1Set(
      asn1Seq(
        asn1Oid('2.5.4.3'), // commonName
        asn1Utf8(cn)
      )
    )
  );
}

function buildSanExtension(ips = []) {
  // DNSName [2] 'localhost'
  const entries = [asn1Tag(0x82, Buffer.from('localhost', 'ascii'))];
  const allIps = Array.from(new Set(['127.0.0.1', ...ips]));
  for (const ip of allIps) {
    const parts = ip.split('.').map(Number);
    if (parts.length === 4 && parts.every((n) => !Number.isNaN(n) && n >= 0 && n <= 255)) {
      // iPAddress [7]
      entries.push(asn1Tag(0x87, Buffer.from(parts)));
    }
  }
  const sanValue = asn1Seq(...entries);
  return asn1Seq(
    asn1Oid('2.5.29.17'), // subjectAltName
    asn1OctetString(sanValue)
  );
}

function generateSelfSignedCert(ips = []) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048
  });

  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  const version = asn1Tag(0xa0, asn1Int(2)); // v3
  const serial = asn1Int(crypto.randomBytes(8));
  // sha256WithRSAEncryption (1.2.840.113549.1.1.11) + NULL
  const sigAlg = asn1Seq(asn1Oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));
  const issuer = buildName('AutoEletrica Pro Local');
  const now = new Date();
  const notBefore = new Date(now.getTime() - 86400000);
  const notAfter = new Date(now.getTime() + 3650 * 86400000);
  const validity = asn1Seq(asn1UtcTime(notBefore), asn1UtcTime(notAfter));
  const subject = issuer;

  const extensions = asn1Tag(0xa3, asn1Seq(buildSanExtension(ips)));

  const tbsCert = asn1Seq(
    version,
    serial,
    sigAlg,
    issuer,
    validity,
    subject,
    spkiDer,
    extensions
  );

  const signature = crypto.sign('sha256', tbsCert, privateKey);
  const fullCertDer = asn1Seq(tbsCert, sigAlg, asn1BitString(signature));

  const b64 = fullCertDer.toString('base64').match(/.{1,64}/g).join('\n');
  const certPem = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;

  return { keyPem, certPem };
}

module.exports = { generateSelfSignedCert };
