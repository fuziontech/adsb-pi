#!/usr/bin/env bash
# adsb-pi installer -- run on the Raspberry Pi:  sudo ./install.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "run as root: sudo ./install.sh"
  exit 1
fi

APP_USER="${SUDO_USER:-james}"
APP_HOME=$(getent passwd "$APP_USER" | cut -d: -f6)
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Installing packages"
apt-get update
apt-get install -y readsb rtl-sdr curl

echo "==> Blacklisting DVB-T kernel drivers (so the SDR is free for ADS-B)"
cat > /etc/modprobe.d/adsb-pi-blacklist.conf <<'EOF'
blacklist dvb_usb_rtl28xxu
blacklist dvb_usb_v2
blacklist rtl2832
blacklist rtl2830
EOF
modprobe -r dvb_usb_rtl28xxu 2>/dev/null || true

echo "==> Configuring readsb"
cat > /etc/default/readsb <<'EOF'
# adsb-pi readsb configuration
RECEIVER_OPTIONS="--device 0 --device-type rtlsdr --gain -10 --ppm 0"
DECODER_OPTIONS="--max-range 450 --fix"
NET_OPTIONS="--net --net-heartbeat 60 --net-ro-size 1300 --net-ro-interval 0.2 --net-ri-port 30001 --net-ro-port 30002 --net-sbs-port 30003 --net-bi-port 30004,30104 --net-bo-port 30005"
JSON_OPTIONS="--write-json /run/readsb --write-json-every 1"
EOF
systemctl enable readsb
systemctl restart readsb

echo "==> Installing radar app to /opt/adsb-pi"
mkdir -p /opt/adsb-pi
rm -rf /opt/adsb-pi/radar /opt/adsb-pi/kiosk
cp -r "$SRC_DIR/radar" /opt/adsb-pi/
cp -r "$SRC_DIR/kiosk" /opt/adsb-pi/
chmod +x /opt/adsb-pi/kiosk/adsb-kiosk.sh

echo "==> Installing adsb-radar systemd service"
sed "s/^User=.*/User=$APP_USER/" "$SRC_DIR/adsb-radar.service" \
  > /etc/systemd/system/adsb-radar.service
systemctl daemon-reload
systemctl enable --now adsb-radar

echo "==> Setting up kiosk autostart on the desktop"
AUTOSTART="$APP_HOME/.config/labwc/autostart"
mkdir -p "$(dirname "$AUTOSTART")"
touch "$AUTOSTART"
if ! grep -q adsb-kiosk "$AUTOSTART"; then
  cat >> "$AUTOSTART" <<'EOF'

# ADS-B radar kiosk (auto-restarts if it crashes)
/usr/bin/lwrespawn /opt/adsb-pi/kiosk/adsb-kiosk.sh &
EOF
fi
chown -R "$APP_USER:$APP_USER" "$(dirname "$AUTOSTART")"

IP=$(hostname -I | awk '{print $1}')
echo
echo "Done."
echo "  Radar UI:  http://$IP:8080/"
echo "  Services:  systemctl status readsb adsb-radar"
echo "  Kiosk starts automatically on next login (or reboot)."
