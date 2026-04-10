#!/usr/bin/env bash
# Deploy browser-agent to a remote VM and install TM script + install page
set -euo pipefail

VM_USER="${VM_USER:?Set VM_USER (SSH username)}"
VM_HOST="${VM_HOST:?Set VM_HOST (SSH hostname)}"
VM_KEY="${VM_KEY:?Set VM_KEY (path to SSH private key)}"
VM_PATH="${VM_PATH:-/home/$VM_USER/browser-agent}"
WEB_ROOT="${WEB_ROOT:-/var/www/html}"

VM="$VM_USER@$VM_HOST"
SSH="ssh -i $VM_KEY $VM"

echo "=== Deploying browser-agent to $VM_HOST ==="

# 1. Sync files to VM + ensure cowork sessions dir
$SSH "mkdir -p $VM_PATH"
scp -i "$VM_KEY" agent-server.js package.json ecosystem.config.js .env "$VM:$VM_PATH/" 2>/dev/null || \
scp -i "$VM_KEY" agent-server.js package.json ecosystem.config.js "$VM:$VM_PATH/"

# 2. Install deps + restart PM2
$SSH "cd $VM_PATH && npm install --production && pm2 delete browser-agent 2>/dev/null; pm2 start ecosystem.config.js && pm2 save"

# 3. Deploy TM userscript + install page to web root (needs sudo)
scp -i "$VM_KEY" browser-agent.user.js install.html "$VM:/tmp/"
$SSH "sudo cp /tmp/browser-agent.user.js $WEB_ROOT/browser-agent.user.js && \
      sudo cp /tmp/install.html $WEB_ROOT/install.html && \
      sudo chown www-data:www-data $WEB_ROOT/browser-agent.user.js $WEB_ROOT/install.html"

echo ""
echo "=== Deployed ==="
echo "Server:  PM2 process 'browser-agent' on port ${BROWSER_AGENT_PORT:-3102}"
echo "Script:  https://$VM_HOST/browser-agent.user.js"
echo "Install: https://$VM_HOST/install.html"
echo "API:     https://$VM_HOST/api/browser-agent/"
