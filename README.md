# QuickPaste

A keyboard-driven clipboard manager for GNOME Shell. Hold `Ctrl`, press `→` to
open your clipboard history, browse it with the arrow keys and release `Ctrl`
to paste the selected item into the focused window.

## Features

- Keeps a history of the text you copy (50 items by default, up to 500).
- Shows which application each item was copied from (browser, VS Code,
  terminal, ...) with its icon and name.
- Pastes directly into the window you were working in, terminals included.
- Configurable shortcut and history size from the panel menu.
- Skips entries that password managers mark as sensitive.
- History lives in memory only: nothing is written to disk.

## Requirements

GNOME Shell 48, 49, 50 or 51.

## Installation

```bash
git clone https://github.com/0-meeseeks-0/gnome-shell-extension-quickpaste.git
cd gnome-shell-extension-quickpaste
./install.sh
```

Then:

1. Log out and log back in (required on Wayland).
2. Enable the extension:

   ```bash
   gnome-extensions enable quickpaste@0-meeseeks-0.io
   ```

The script copies the extension to
`~/.local/share/gnome-shell/extensions/quickpaste@0-meeseeks-0.io` and compiles
its settings schema.

## Usage

1. Copy text as usual (`Ctrl+C`).
2. Hold `Ctrl` and press `→` to open the popup. It shows the most recent item,
   the app it was copied from and its position in the history (`[ 1 - 12 ]`).
3. Keep `Ctrl` held and use the keys below.
4. Release `Ctrl` to paste the item shown.

| Key                    | Action                         |
| ---------------------- | ------------------------------ |
| `←`                    | Older item                     |
| `→`                    | Newer item                     |
| `Del` / `Backspace`    | Delete the item shown          |
| `Esc`                  | Close without pasting          |
| Release `Ctrl`         | Paste the item shown           |

## Settings

Click the clipboard icon in the top panel:

- **Max items** – maximum number of items kept (`−` / `+`, steps of 5).
- **Shortcut** – record a new shortcut. It must include `Ctrl`, because
  releasing `Ctrl` is what triggers the paste.
- **Clear history** – clear the history.
- **Quit** – clear the history and disable the extension.

## Notes

- The source app is the window that has focus at the moment of the copy;
  GNOME does not expose the real clipboard owner. Copies made by background
  tools are attributed to the foreground app, or shown as "Unknown source"
  when no window is focused.
- The history survives a screen lock but is lost when you log out.

## Uninstall

```bash
gnome-extensions disable quickpaste@0-meeseeks-0.io
rm -rf ~/.local/share/gnome-shell/extensions/quickpaste@0-meeseeks-0.io
```

## License

QuickPaste is free software, released under the
[GNU General Public License](LICENSE).
