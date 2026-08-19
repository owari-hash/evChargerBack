#!/usr/bin/env bash
# Install nginx and the eplug.mn TLS certificate on Ubuntu/Debian, then enable
# the CSMS site. Run as root on the server:
#
#   sudo ./install-nginx-ubuntu.sh <fullchain.crt> <eplug.mn.key> [bundle_files.crt]
#
# fullchain.crt = eplug.crt followed by bundle_files.crt. If you only have the
# two files from the CA, build it first:
#   cat eplug.crt bundle_files.crt > fullchain.crt
set -euo pipefail

CERT_SRC=${1:?usage: install-nginx-ubuntu.sh <fullchain.crt> <privkey.key> [bundle.crt]}
KEY_SRC=${2:?missing private key path}
BUNDLE_SRC=${3:-}
SSL_DIR=/etc/nginx/ssl/eplug.mn
SITE_SRC="$(dirname "$(readlink -f "$0")")/nginx-eplug.mn.conf"

[[ $EUID -eq 0 ]] || { echo "run as root (sudo)"; exit 1; }

echo "==> Checking that the key matches the certificate"
cert_mod=$(openssl x509 -noout -modulus -in "$CERT_SRC" | openssl sha256)
key_mod=$(openssl rsa  -noout -modulus -in "$KEY_SRC"  | openssl sha256)
if [[ "$cert_mod" != "$key_mod" ]]; then
    echo "ERROR: private key does not match the certificate" >&2
    exit 1
fi
openssl x509 -in "$CERT_SRC" -noout -subject -dates -ext subjectAltName

echo "==> Installing nginx"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y nginx openssl

echo "==> Installing certificate into $SSL_DIR"
install -d -m 700 -o root -g root "$SSL_DIR"
install -m 644 -o root -g root "$CERT_SRC" "$SSL_DIR/fullchain.crt"
install -m 600 -o root -g root "$KEY_SRC"  "$SSL_DIR/eplug.mn.key"
if [[ -n "$BUNDLE_SRC" ]]; then
    install -m 644 -o root -g root "$BUNDLE_SRC" "$SSL_DIR/bundle_files.crt"
else
    # OCSP stapling needs the issuer chain without the leaf.
    awk 'BEGIN{n=0} /BEGIN CERTIFICATE/{n++} n>1' "$CERT_SRC" > "$SSL_DIR/bundle_files.crt"
    chmod 644 "$SSL_DIR/bundle_files.crt"
fi

echo "==> Enabling the eplug.mn site"
install -m 644 "$SITE_SRC" /etc/nginx/sites-available/eplug.mn
ln -sf /etc/nginx/sites-available/eplug.mn /etc/nginx/sites-enabled/eplug.mn
rm -f /etc/nginx/sites-enabled/default

echo "==> Opening the firewall (if ufw is active)"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
    ufw allow 'Nginx Full'
fi

echo "==> Testing and reloading nginx"
nginx -t
systemctl enable --now nginx
systemctl reload nginx

cat <<'DONE'

nginx is up. Verify once the CSMS process is running on 127.0.0.1:3000:

  curl -sS https://eplug.mn/api/health
  curl -sS https://eplug.mn/api | head -c 200
  openssl s_client -connect eplug.mn:443 -servername eplug.mn -status </dev/null 2>/dev/null | head -20

The certificate expires 2027-03-05 — reinstall with this script when you renew.
DONE
