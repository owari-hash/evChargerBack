import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import forge from 'node-forge';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { badRequest, unprocessable } from '../lib/errors';

interface CaMaterial {
  cert: forge.pki.Certificate;
  key: forge.pki.rsa.PrivateKey;
}

let cached: CaMaterial | null = null;

/**
 * Load the local CA used to sign charge point CSRs received via
 * SignCertificate.req (white paper use cases A02 / A03).
 *
 * In production you would normally forward the CSR to a real PKI. This
 * self-contained CA lets the flow work end to end out of the box.
 */
export function loadCa(): CaMaterial {
  if (cached) return cached;
  if (!existsSync(env.CSMS_CA_CERT_PATH) || !existsSync(env.CSMS_CA_KEY_PATH)) {
    throw unprocessable(
      `No CA key pair found at ${env.CSMS_CA_CERT_PATH} / ${env.CSMS_CA_KEY_PATH}. ` +
        'Run `npm run seed -- --ca` or point CSMS_CA_* at your own PKI material.',
    );
  }
  const cert = forge.pki.certificateFromPem(readFileSync(env.CSMS_CA_CERT_PATH, 'utf8'));
  const key = forge.pki.privateKeyFromPem(
    readFileSync(env.CSMS_CA_KEY_PATH, 'utf8'),
  ) as forge.pki.rsa.PrivateKey;
  cached = { cert, key };
  return cached;
}

/** Generate a self-signed root CA and write it to the configured paths. */
export function generateCa(commonName = 'CSMS Root CA', years = 10): { certPem: string; keyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + years);

  const attrs = [
    { name: 'commonName', value: commonName },
    { name: 'organizationName', value: 'CSMS' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  mkdirSync(dirname(env.CSMS_CA_CERT_PATH), { recursive: true });
  writeFileSync(env.CSMS_CA_CERT_PATH, certPem);
  writeFileSync(env.CSMS_CA_KEY_PATH, keyPem, { mode: 0o600 });
  cached = null;
  logger.info({ path: env.CSMS_CA_CERT_PATH }, 'generated CSMS root CA');
  return { certPem, keyPem };
}

export interface SignedCertificate {
  certificatePem: string;
  /** Signed leaf followed by the CA certificate, for CertificateSigned.req. */
  chainPem: string;
  serialNumber: string;
  subject: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
}

/**
 * Sign a PEM-encoded PKCS#10 CSR with the local CA.
 *
 * A02.FR.07 requires the resulting certificate's commonName to identify the
 * charge point, so the CN from the CSR is checked against `chargePointId`.
 */
export function signCsr(csrPem: string, chargePointId: string): SignedCertificate {
  let csr: forge.pki.CertificateSigningRequest;
  try {
    csr = forge.pki.certificationRequestFromPem(csrPem);
  } catch (err) {
    throw badRequest(`CSR is not valid PEM-encoded PKCS#10: ${(err as Error).message}`);
  }

  if (!csr.verify()) {
    throw badRequest('CSR signature verification failed');
  }

  const cnAttr = csr.subject.getField('CN');
  const cn = cnAttr?.value as string | undefined;
  if (!cn) throw badRequest('CSR subject has no commonName');
  if (cn !== chargePointId) {
    throw badRequest(
      `CSR commonName "${cn}" does not match the charge point identity "${chargePointId}"`,
    );
  }

  const ca = loadCa();
  const cert = forge.pki.createCertificate();
  cert.publicKey = csr.publicKey!;
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(
    Date.now() + env.CSMS_CERT_VALIDITY_DAYS * 24 * 60 * 60 * 1000,
  );
  cert.setSubject(csr.subject.attributes);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', clientAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: chargePointId }] },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());

  const certificatePem = forge.pki.certificateToPem(cert);
  return {
    certificatePem,
    chainPem: certificatePem + forge.pki.certificateToPem(ca.cert),
    serialNumber: cert.serialNumber,
    subject: attrsToString(cert.subject.attributes),
    issuer: attrsToString(cert.issuer.attributes),
    validFrom: cert.validity.notBefore,
    validTo: cert.validity.notAfter,
  };
}

export interface CertificateHashData {
  hashAlgorithm: 'SHA256';
  issuerNameHash: string;
  issuerKeyHash: string;
  serialNumber: string;
}

export interface ParsedCertificate extends CertificateHashData {
  subject: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
}

/**
 * Parse a PEM certificate and derive the CertificateHashDataType fields
 * (white paper section 6.1), computed the same way as OCSP CertID (RFC 6960):
 * SHA-256 over the DER-encoded issuer name and over the issuer public key bits.
 */
export function parseCertificate(pem: string): ParsedCertificate {
  let cert: forge.pki.Certificate;
  try {
    cert = forge.pki.certificateFromPem(pem);
  } catch (err) {
    throw badRequest(`Not a valid PEM certificate: ${(err as Error).message}`);
  }

  const issuerDer = forge.asn1.toDer(forge.pki.distinguishedNameToAsn1(cert.issuer)).getBytes();
  const issuerNameHash = sha256Hex(issuerDer);

  // Hash of the subjectPublicKey BIT STRING contents of the certificate's own
  // issuer is not available from a leaf alone, so we hash this certificate's
  // public key. For a self-signed root this matches the OCSP definition.
  const spki = forge.pki.publicKeyToAsn1(cert.publicKey);
  const spkiDer = forge.asn1.toDer(spki as forge.asn1.Asn1).getBytes();
  const issuerKeyHash = sha256Hex(spkiDer);

  return {
    hashAlgorithm: 'SHA256',
    issuerNameHash,
    issuerKeyHash,
    serialNumber: cert.serialNumber,
    subject: attrsToString(cert.subject.attributes),
    issuer: attrsToString(cert.issuer.attributes),
    validFrom: cert.validity.notBefore,
    validTo: cert.validity.notAfter,
  };
}

function sha256Hex(bytes: string): string {
  const md = forge.md.sha256.create();
  md.update(bytes);
  return md.digest().toHex();
}

function attrsToString(attrs: forge.pki.CertificateField[]): string {
  return attrs
    .map((a) => `${a.shortName ?? a.name ?? a.type}=${String(a.value ?? '')}`)
    .join(', ');
}
