// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 0-meeseeks-0

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const POPUP_WIDTH = 640;
const POPUP_HEIGHT = 280;
const PREVIEW_CHARS = 2000;      // max characters shown in the preview
const PASTE_DELAY_MS = 120;      // delay before simulating the paste
const SELF_COPY_WINDOW_US = 1000000;
const MAX_STEP = 5;              // step of the − / + buttons in the menu
const MAX_LIMIT = 500;
const SOURCE_ICON_SIZE = 16;
const UNKNOWN_SOURCE = 'Unknown source';
const UNKNOWN_ICON = 'application-x-executable-symbolic';

const HINT_BROWSE = '←  older    →  newer    Del  delete    Esc  cancel';
const HINT_CAPTURE = 'Esc  cancel';

const MODIFIER_KEYS = new Set([
    Clutter.KEY_Control_L, Clutter.KEY_Control_R,
    Clutter.KEY_Shift_L, Clutter.KEY_Shift_R,
    Clutter.KEY_Alt_L, Clutter.KEY_Alt_R,
    Clutter.KEY_Super_L, Clutter.KEY_Super_R,
    Clutter.KEY_Meta_L, Clutter.KEY_Meta_R,
    Clutter.KEY_ISO_Level3_Shift,
    Clutter.KEY_Caps_Lock, Clutter.KEY_Num_Lock,
]);

// "<Control><Alt>v" -> "Ctrl+Alt+V"
function prettyAccel(accel) {
    if (!accel)
        return 'none';
    const names = {Control: 'Ctrl', Primary: 'Ctrl'};
    const keys = {Left: '←', Right: '→', Up: '↑', Down: '↓'};
    const parts = [];
    const key = accel.replace(/<([^>]+)>/g, (_m, mod) => {
        parts.push(names[mod] ?? mod);
        return '';
    });
    parts.push(keys[key] ?? (key.length === 1 ? key.toUpperCase() : key));
    return parts.join('+');
}

// Kept at module level: GNOME disables extensions when the screen locks, so
// this lets the history survive a lock. The "Quit" menu action clears it.
// history[0] is the most recent item. Each item is
// {text, appName, appIcon}: appName/appIcon describe the app the text was
// copied from (null when it could not be determined).
const state = {history: [], index: 0};

export default class QuickPaste extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._isOpen = false;
        this._capturing = false;
        this._grab = null;
        this._pasteTimeoutId = 0;
        this._idleId = 0;
        this._selfText = null;
        this._selfTime = 0;

        const backend = global.stage.context?.get_backend?.() ??
            Clutter.get_default_backend();
        this._keyboard = backend.get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        this._buildPopup();
        this._buildIndicator();

        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect('owner-changed',
            (_sel, type) => {
                if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                    this._readClipboard();
            });

        this._maxChangedId = this._settings.connect('changed::max-items', () => {
            this._trim();
            this._updateMaxLabel();
        });
        this._shortcutChangedId = this._settings.connect(
            'changed::toggle-shortcut', () => this._updateShortcutLabel());
        this._trim();

        Main.wm.addKeybinding('toggle-shortcut', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL,
            () => this._open());
    }

    disable() {
        Main.wm.removeKeybinding('toggle-shortcut');
        this._close(false);

        if (this._pasteTimeoutId) {
            GLib.source_remove(this._pasteTimeoutId);
            this._pasteTimeoutId = 0;
        }
        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }
        if (this._ownerChangedId) {
            this._selection.disconnect(this._ownerChangedId);
            this._ownerChangedId = 0;
        }
        if (this._maxChangedId) {
            this._settings.disconnect(this._maxChangedId);
            this._maxChangedId = 0;
        }

        if (this._shortcutChangedId) {
            this._settings.disconnect(this._shortcutChangedId);
            this._shortcutChangedId = 0;
        }

        this._indicator?.destroy();
        this._indicator = null;
        this._maxLabel = null;
        this._shortcutItem = null;

        this._popup?.destroy();
        this._popup = null;
        this._header = null;
        this._sourceIcon = null;
        this._counter = null;
        this._text = null;
        this._hint = null;

        this._selection = null;
        this._keyboard = null;
        this._settings = null;
    }

    // --------------------------------------------------------------- history

    get _max() {
        return this._settings.get_int('max-items');
    }

    _trim() {
        if (state.history.length > this._max)
            state.history.length = this._max;
        state.index = Math.max(0, Math.min(state.index, state.history.length - 1));
    }

    _readClipboard() {
        const clipboard = St.Clipboard.get_default();

        // Do not store what password managers flag as sensitive.
        const mimes = clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD) ?? [];
        if (mimes.includes('x-kde-passwordManagerHint'))
            return;

        // Must be read now, before the asynchronous text read: afterwards the
        // focus may already have moved to another window.
        const source = this._currentSource();

        clipboard.get_text(St.ClipboardType.CLIPBOARD, (_cb, text) => {
            if (!this._settings || !text)
                return;

            // This is the text we just put on the clipboard ourselves in order
            // to paste it: it must change neither the order nor the position.
            if (text === this._selfText &&
                GLib.get_monotonic_time() - this._selfTime < SELF_COPY_WINDOW_US)
                return;

            const pos = state.history.findIndex(it => it.text === text);
            if (pos !== -1)
                state.history.splice(pos, 1);   // already present: move to front
            state.history.unshift({text, ...source});
            state.index = 0;                    // new copy => start again from the front
            this._trim();

            if (this._isOpen)
                this._refresh();
        });
    }

    // App the copy comes from. On Wayland the compositor does not tell who
    // owns the clipboard, but whoever copies is (almost always) the window
    // focused at that moment: browser, VS Code, terminal, ...
    _currentSource() {
        const win = global.display.focus_window;
        const tracker = Shell.WindowTracker.get_default();
        const app = (win ? tracker.get_window_app(win) : null) ?? tracker.focus_app;
        return {
            appName: app?.get_name() ?? win?.get_wm_class() ?? null,
            appIcon: app?.get_icon() ?? null,
        };
    }

    // ----------------------------------------------------------------- popup

    _buildPopup() {
        this._popup = new St.BoxLayout({
            style_class: 'quickpaste-popup',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            can_focus: true,
            visible: false,
            width: POPUP_WIDTH,
            height: POPUP_HEIGHT,
            clip_to_allocation: true,
        });

        // Header: [icon] Name of the source app
        const headerBox = new St.BoxLayout({style_class: 'quickpaste-header-box'});
        this._sourceIcon = new St.Icon({
            style_class: 'quickpaste-source-icon',
            icon_size: SOURCE_ICON_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._header = new St.Label({
            style_class: 'quickpaste-header',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._header.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        headerBox.add_child(this._sourceIcon);
        headerBox.add_child(this._header);

        this._text = new St.Label({
            style_class: 'quickpaste-text',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.START,
        });
        this._text.clutter_text.line_wrap = true;
        this._text.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._text.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        // Footer: centered "[ 3 - 12 ]" counter with the key hints below it.
        const footerBox = new St.BoxLayout({
            style_class: 'quickpaste-footer-box',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._counter = new St.Label({
            style_class: 'quickpaste-counter',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._hint = new St.Label({
            style_class: 'quickpaste-hint',
            text: HINT_BROWSE,
            x_align: Clutter.ActorAlign.CENTER,
        });
        footerBox.add_child(this._counter);
        footerBox.add_child(this._hint);

        this._popup.add_child(headerBox);
        this._popup.add_child(this._text);
        this._popup.add_child(footerBox);

        this._popup.connect('key-press-event', this._onKeyPress.bind(this));
        this._popup.connect('key-release-event', this._onKeyRelease.bind(this));

        Main.uiGroup.add_child(this._popup);
    }

    // Header without a source app (empty history, shortcut change).
    _setPlainHeader(title) {
        this._sourceIcon.hide();
        this._header.text = title;
        this._counter.hide();
    }

    _refresh() {
        const n = state.history.length;
        if (n === 0) {
            this._setPlainHeader('QuickPaste');
            this._text.text = 'No copied items';
            return;
        }
        const item = state.history[state.index];
        this._sourceIcon.gicon = item.appIcon ?? Gio.ThemedIcon.new(UNKNOWN_ICON);
        this._sourceIcon.show();
        this._header.text = item.appName ?? UNKNOWN_SOURCE;
        this._counter.text = `[ ${state.index + 1} - ${n} ]`;
        this._counter.show();
        this._text.text = item.text.length > PREVIEW_CHARS
            ? `${item.text.slice(0, PREVIEW_CHARS)}…`
            : item.text;
    }

    _showPopup() {
        // Monitor of the focused window (otherwise the one under the pointer).
        const idx = global.display.focus_window?.get_monitor() ??
            global.display.get_current_monitor();
        const mon = Main.layoutManager.monitors[idx] ??
            Main.layoutManager.primaryMonitor;

        this._popup.set_position(
            mon.x + Math.floor((mon.width - POPUP_WIDTH) / 2),
            mon.y + Math.floor((mon.height - POPUP_HEIGHT) / 2));
        Main.uiGroup.set_child_above_sibling(this._popup, null);
        this._popup.show();

        // Note: grab.get_seat_state() no longer exists since GNOME 50, so the
        // grab type is not checked (same as the Shell itself does).
        this._grab = Main.pushModal(this._popup);
        this._isOpen = true;
    }

    _open() {
        if (this._isOpen)
            return;

        this._capturing = false;
        this._hint.text = HINT_BROWSE;
        this._trim();
        this._refresh();
        this._showPopup();

        // Ctrl already released before the popup appeared: paste right away.
        if (!this._ctrlHeld())
            this._close(true);
    }

    _close(paste) {
        if (!this._isOpen)
            return;
        this._isOpen = false;
        const wasCapturing = this._capturing;
        this._capturing = false;

        Main.popModal(this._grab);
        this._grab = null;
        this._popup.hide();

        if (paste && !wasCapturing && state.history.length > 0)
            this._paste(state.history[state.index].text);
    }

    // ------------------------------------------------------- shortcut change

    get _shortcut() {
        return this._settings.get_strv('toggle-shortcut')[0] ?? '';
    }

    _startCapture() {
        if (this._isOpen)
            return;
        this._capturing = true;
        this._setPlainHeader('New shortcut');
        this._text.text =
            'Press the new key combination.\n' +
            'It must include Ctrl (e.g. Ctrl+→ or Ctrl+Alt+V).\n\n' +
            `Current: ${prettyAccel(this._shortcut)}`;
        this._hint.text = HINT_CAPTURE;
        this._showPopup();
    }

    _onCaptureKey(event) {
        const sym = event.get_key_symbol();
        if (sym === Clutter.KEY_Escape) {
            this._close(false);
            return;
        }
        if (MODIFIER_KEYS.has(sym))
            return;     // wait for the "real" key

        const st = event.get_state();
        let mods = st & (Clutter.ModifierType.CONTROL_MASK |
            Clutter.ModifierType.SHIFT_MASK |
            Clutter.ModifierType.MOD1_MASK |
            Clutter.ModifierType.SUPER_MASK);
        if (st & Clutter.ModifierType.MOD4_MASK)
            mods |= Clutter.ModifierType.SUPER_MASK;

        // Ctrl is mandatory: releasing it is what triggers the paste.
        if (!(mods & Clutter.ModifierType.CONTROL_MASK)) {
            this._text.text =
                'The combination must include Ctrl. Try again.\n\n' +
                `Current: ${prettyAccel(this._shortcut)}`;
            return;
        }

        const accel = Meta.accelerator_name(mods, sym);
        if (!accel)
            return;
        this._settings.set_strv('toggle-shortcut', [accel]);
        this._close(false);
    }

    _ctrlHeld() {
        const [, , mods] = global.get_pointer();
        return (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
    }

    _move(delta) {
        const n = state.history.length;
        if (n === 0)
            return;
        state.index = Math.max(0, Math.min(state.index + delta, n - 1));
        this._refresh();
    }

    _onKeyPress(_actor, event) {
        if (this._capturing) {
            this._onCaptureKey(event);
            return Clutter.EVENT_STOP;
        }

        switch (event.get_key_symbol()) {
        case Clutter.KEY_Left:
        case Clutter.KEY_KP_Left:
            this._move(+1);     // towards older items
            break;
        case Clutter.KEY_Right:
        case Clutter.KEY_KP_Right:
            this._move(-1);     // towards newer items
            break;
        case Clutter.KEY_Delete:
        case Clutter.KEY_KP_Delete:
        case Clutter.KEY_BackSpace:
            if (state.history.length > 0) {
                state.history.splice(state.index, 1);
                this._trim();
                this._refresh();
            }
            break;
        case Clutter.KEY_Escape:
            this._close(false);
            break;
        }
        return Clutter.EVENT_STOP;
    }

    _onKeyRelease(_actor, event) {
        if (this._capturing)
            return Clutter.EVENT_STOP;

        const sym = event.get_key_symbol();
        if (sym === Clutter.KEY_Control_L || sym === Clutter.KEY_Control_R ||
            !this._ctrlHeld())
            this._close(true);
        return Clutter.EVENT_STOP;
    }

    // ----------------------------------------------------------------- paste

    _paste(text) {
        this._selfText = text;
        this._selfTime = GLib.get_monotonic_time();

        // Shift+Ins pastes CLIPBOARD in regular apps and PRIMARY in terminals:
        // setting both makes it work everywhere.
        const clipboard = St.Clipboard.get_default();
        clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        clipboard.set_text(St.ClipboardType.PRIMARY, text);

        if (this._pasteTimeoutId)
            GLib.source_remove(this._pasteTimeoutId);

        // Short wait: focus has to return to the previous window.
        this._pasteTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            PASTE_DELAY_MS, () => {
                this._pasteTimeoutId = 0;
                const kb = this._keyboard;
                if (!kb)
                    return GLib.SOURCE_REMOVE;
                const t = GLib.get_monotonic_time();
                kb.notify_keyval(t, Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
                kb.notify_keyval(t, Clutter.KEY_Insert, Clutter.KeyState.PRESSED);
                kb.notify_keyval(t, Clutter.KEY_Insert, Clutter.KeyState.RELEASED);
                kb.notify_keyval(t, Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
                return GLib.SOURCE_REMOVE;
            });
    }

    // ------------------------------------------------------------ panel icon

    _buildIndicator() {
        this._indicator = new PanelMenu.Button(0.0, 'QuickPaste', false);
        this._indicator.add_child(new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon',
        }));

        // Row "Max items   −  50  +"
        const row = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        row.add_child(new St.Label({
            text: 'Max items',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const minus = new St.Button({
            label: '−', style_class: 'button quickpaste-step', can_focus: true,
        });
        this._maxLabel = new St.Label({
            style_class: 'quickpaste-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const plus = new St.Button({
            label: '+', style_class: 'button quickpaste-step', can_focus: true,
        });
        minus.connect('clicked', () => this._stepMax(-1));
        plus.connect('clicked', () => this._stepMax(+1));
        row.add_child(minus);
        row.add_child(this._maxLabel);
        row.add_child(plus);
        this._indicator.menu.addMenuItem(row);
        this._updateMaxLabel();

        // "Shortcut: Ctrl+→" — clicking it records a new key combination
        this._shortcutItem = this._indicator.menu.addAction('', () => {
            // Deferred: the menu must close and release the keyboard first.
            this._defer(() => this._startCapture());
        });
        this._updateShortcutLabel();

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._indicator.menu.addAction('Clear history', () => {
            state.history.length = 0;
            state.index = 0;
        });

        this._indicator.menu.addAction('Quit', () => {
            // Deferred: the menu cannot be destroyed while it handles the click.
            this._defer(() => {
                state.history.length = 0;
                state.index = 0;
                Main.extensionManager.disableExtension(this.uuid);
            });
        });

        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    _defer(fn) {
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleId = 0;
            fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateShortcutLabel() {
        if (this._shortcutItem)
            this._shortcutItem.label.text = `Shortcut: ${prettyAccel(this._shortcut)}…`;
    }

    _stepMax(direction) {
        // 50 -> 55 -> 60 ... and 50 -> 45 ... -> 5 -> 1
        const cur = this._max;
        let next = direction > 0
            ? (Math.floor(cur / MAX_STEP) + 1) * MAX_STEP
            : (Math.ceil(cur / MAX_STEP) - 1) * MAX_STEP;
        next = Math.max(1, Math.min(next, MAX_LIMIT));
        this._settings.set_int('max-items', next);
    }

    _updateMaxLabel() {
        if (this._maxLabel)
            this._maxLabel.text = String(this._max);
    }
}
