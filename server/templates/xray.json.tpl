{
  "log": {
    "loglevel": "warning"
  },
  "inbounds": [
    {
      "tag": "vless-reality",
      "listen": "0.0.0.0",
      "port": 443,
      "protocol": "vless",
      "settings": {
        "clients": [
          {
            "id": "@XRAY_UUID@",
            "flow": "xtls-rprx-vision",
            "email": "user"
          }
        ],
        "decryption": "none",
        "fallbacks": [
          {
            "dest": "caddy:8443",
            "xver": 0
          }
        ]
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "show": false,
          "dest": "caddy:8443",
          "xver": 0,
          "serverNames": [
            "@CHAT_DOMAIN@"
          ],
          "privateKey": "@XRAY_PRIVATE_KEY@",
          "shortIds": [
            "@XRAY_SHORT_ID@"
          ]
        }
      },
      "sniffing": {
        "enabled": true,
        "destOverride": [
          "http",
          "tls",
          "quic"
        ]
      }
    }
  ],
  "outbounds": [
    {
      "tag": "direct",
      "protocol": "freedom"
    },
    {
      "tag": "block",
      "protocol": "blackhole"
    }
  ],
  "routing": {
    "domainStrategy": "IPIfNonMatch",
    "rules": [
      {
        "type": "field",
        "ip": [
          "geoip:private"
        ],
        "outboundTag": "block"
      }
    ]
  }
}
