# Deploying the bot to a Linux server (24/7)

This guide moves the bot from your PC to a Linux server so it stays online. The
included `sgkz-bot.tar.gz` bundle already contains your code **and** your
`.env` + `data/store.json` (registrations, rank-role IDs, pinned-leaderboard id),
so nothing is lost in the move.

> 🔒 **Reset your Discord token first.** It was shared in chat. Go to the Dev
> Portal → Bot → **Reset Token**, then paste the new one into `.env` on the
> server (step 4). Old token = anyone can control your bot.

> ⚠️ **Run only one copy.** Once the Linux bot is up, stop the one on your PC,
> or both will double-post. Two instances = every announcement twice.

---

## 1. Install Node.js 20+ on the server

**Debian / Ubuntu:**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v      # should print v20.x or newer
```
Other distros: use your package manager or [nvm](https://github.com/nvm-sh/nvm). Node **18+** is required (20 LTS recommended).

## 2. Copy the bundle to the server

From your PC (the bundle was sent to you as `sgkz-bot.tar.gz`):
```bash
scp sgkz-bot.tar.gz youruser@YOUR_SERVER_IP:~
```

## 3. Extract it

On the server:
```bash
sudo mkdir -p /opt/sgkz-bot
sudo tar -xzf ~/sgkz-bot.tar.gz -C /opt/sgkz-bot
cd /opt/sgkz-bot
```

## 4. Configure and install

```bash
nano .env          # paste your NEW bot token, save (Ctrl+O, Enter, Ctrl+X)
npm ci             # install dependencies from package-lock (clean & reproducible)
npm run deploy     # register the /sgkz command (run once)
```

Quick test that it logs in (Ctrl+C to stop after you see "Logged in"):
```bash
npm start
```

## 5. Run it 24/7 with systemd (recommended)

Create a dedicated user and install the service:
```bash
sudo useradd --system --no-create-home sgkz          # skip if you'll run as yourself
sudo chown -R sgkz:sgkz /opt/sgkz-bot                # match the User in the unit
sudo cp deploy/sgkz-bot.service /etc/systemd/system/
# If node isn't at /usr/bin/node or you use a different user/path, edit the unit:
#   sudo nano /etc/systemd/system/sgkz-bot.service   (run `which node` to check)
sudo systemctl daemon-reload
sudo systemctl enable --now sgkz-bot
```

Check it:
```bash
systemctl status sgkz-bot
journalctl -u sgkz-bot -f      # live logs; Ctrl+C to exit
```

It now starts on boot and restarts automatically if it crashes.

### Everyday commands
```bash
sudo systemctl restart sgkz-bot   # after editing .env or updating code
sudo systemctl stop sgkz-bot
journalctl -u sgkz-bot --since "10 min ago"
```

## Alternative: pm2 (simpler, no root service)
```bash
sudo npm install -g pm2
cd /opt/sgkz-bot
pm2 start src/index.js --name sgkz-bot
pm2 save
pm2 startup        # run the command it prints, to start pm2 on boot
pm2 logs sgkz-bot
```

## 6. Turn off the PC copy

Once the server bot is confirmed online (you see it respond to `/sgkz help`),
stop the instance running on your Windows PC so nothing double-posts.

## Updating later

Copy the changed files up (or `git pull` if you put it in a repo), then:
```bash
cd /opt/sgkz-bot
npm ci                       # only if dependencies changed
npm run deploy               # only if commands changed
sudo systemctl restart sgkz-bot
```
