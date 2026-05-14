# MikroTik Woobm telnet client

Python library for automating MikroTik RouterOS over a **Woobm-USB** serial bridge.
The Woobm connects to any RouterBOARD with a USB port and exposes its serial console
over WiFi via telnet (port 23) and WebSocket. This library uses telnet.

- https://help.mikrotik.com/docs/spaces/UM/pages/14222401/Woobm-USB
- https://mikrotik.com/product/woobm

## Usage

Credentials and host are loaded from `.env`:

```
MIKROTIK_HOST=192.168.4.1   # Woobm default IP
MIKROTIK_PORT=23
MIKROTIK_LOGIN=admin
MIKROTIK_PASSWORD=<password>
```

```
python mikrotik_telnet.py "/system identity print"   # single command
python mikrotik_telnet.py -f commands.txt            # batch (one command per line)
python mikrotik_telnet.py                            # interactive
```

## Behaviour

**One concurrent session only.** The Woobm bridges a single serial port. Close browser
terminal tabs and any other telnet sessions before connecting.

**Boot delay.** After the router reboots, the USB-to-serial console takes ~60–90 seconds
to become ready. Connecting earlier gives "Login failed" or no response — this is not a
wrong password. The script retries on login failure automatically.

**First-login wizard.** RouterOS 7 shows a password-change wizard on the first console
login after netinstall or password reset. The wizard rejects empty passwords —
`MIKROTIK_PASSWORD` in `.env` must be non-empty. The password can be cleared in Winbox
afterwards if desired.

**Unknown interactive prompts** raise `UnexpectedPromptError` with the prompt text and
exit with code 2, so the caller can inspect and decide how to respond.
