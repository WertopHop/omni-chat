# Rendered by scripts/gen-config.sh - do not edit generated/chat.toml by hand.
# The backend mounts this file as /Revolt.toml.

[hosts]
app = "https://@CHAT_DOMAIN@"
api = "https://@CHAT_DOMAIN@/api"
events = "wss://@CHAT_DOMAIN@/ws"
autumn = "https://@CHAT_DOMAIN@/autumn"
january = "https://@CHAT_DOMAIN@/january"
gifbox = "https://@CHAT_DOMAIN@/gifbox"

[hosts.livekit]
worldwide = "wss://@CHAT_DOMAIN@/livekit"

[api.livekit.nodes.worldwide]
url = "http://livekit:7880"
lat = 0.0
lon = 0.0

# Closed instance: an account can only be created with an invite code issued
# by tools/issue-invite.sh.
[api.registration]
invite_only = true

[files.s3]
endpoint = "http://minio:9000"
region = "minio"
access_key_id = "@S3_ROOT_USER@"
secret_access_key = "@S3_ROOT_PASSWORD@"
default_bucket = "revolt-uploads"

[features.limits.new_user]
video_resolution = [1920, 1080]
video_aspect_ratio = [0.3, 10]

[features.limits.default]
video_resolution = [1920, 1080]
video_aspect_ratio = [0.3, 10]
