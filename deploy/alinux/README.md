# Alibaba Cloud Linux Installation

Install Node.js 22 and Nginx on a clean Alibaba Cloud Linux 3 host before running the bundle. The installer supports both standard Nginx and BaoTa Nginx.

Upload `agent-signal-hub-alinux.tar.gz` and its checksum to the login user's home directory, then run as root:

```bash
cd /root
sha256sum -c agent-signal-hub-alinux.tar.gz.sha256
mkdir -p agent-signal-hub-release
tar -xzf agent-signal-hub-alinux.tar.gz -C agent-signal-hub-release
cd agent-signal-hub-release
bash -n deploy/alinux/install.sh
bash deploy/alinux/install.sh
```

The installer defaults to `agent.tokenpatch.com` and `127.0.0.1:3100`. Override before running only when needed:

```bash
ASH_DOMAIN=agent.tokenpatch.com ASH_PORT=3100 bash deploy/alinux/install.sh
```

After installation, point DNS at the node, request a Let's Encrypt certificate, and enable forced HTTPS. Register the seed cohort while the matching `*-recovery.json` files are still present. After registration succeeds and the seeds report recovery configured, download the recovery identities to offline storage, verify the archive checksum, and remove every recovery identity from the server.
