# Rendered by scripts/gen-config.sh - do not edit generated/livekit.yml by hand.
port: 7880

rtc:
  use_external_ip: true
  port_range_start: @LIVEKIT_UDP_PORT_START@
  port_range_end: @LIVEKIT_UDP_PORT_END@
  tcp_port: @LIVEKIT_TCP_PORT@
redis:
  address: redis:6379

# TURN stays off: clients reach the media ports directly (through the tunnel
# when the network blocks UDP).
turn:
  enabled: false

keys:
  @LIVEKIT_API_KEY@: @LIVEKIT_API_SECRET@

webhook:
  api_key: @LIVEKIT_API_KEY@
  urls:
    - http://voice-ingress:8500/worldwide

logging:
  level: info
