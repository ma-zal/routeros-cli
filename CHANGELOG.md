# Changelog

## [0.1.1] - 2026-05-15

### fix

- Unexpected output line wrapping at 80 characters

  RouterOS probes terminal dimensions after login using an ANSI DSR sequence
  (`ESC[6n`). Without a response it falls back to 80-column output, breaking
  long lines (e.g. `/export terse`).

  Two complementary mechanisms now prevent this:
  - Login username is sent with `+t4096w9999h` (RouterOS login options): disables
    terminal auto-detection (`t`), sets width to 4096 (`4096w`) and height to 9999
    (`9999h`). Supported in RouterOS 6.x and newer.
  - If the terminal probe `ESC[6n` still arrives (older RouterOS versions that
    ignore login options), the login sequence replies with `ESC[1;4096R`,
    reporting column 4096 as the cursor position.

## [0.1.0] - 2026-04-21

Initial release.
