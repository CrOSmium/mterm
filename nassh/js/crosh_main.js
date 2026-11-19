// Copyright 2012 The ChromiumOS Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {lib} from '../../libdot/index.js';

import {hterm} from '../../hterm/index.js';

import {
  disableTabDiscarding, getSyncStorage, isCrOSSystemApp, loadWebFonts,
  openOptionsPage, osc8Link, sendFeedback, setupForWebApp, sgrText,
} from './nassh.js';

/**
 * CSP means that we can't kick off the initialization from the html file,
 * so we do it like this instead.
 */
globalThis.addEventListener('DOMContentLoaded', async (event) => {
  // If we're being opened by a link from another page, clear the opener setting
  // so we can't reach back into them.  They should have used noopener, but help
  // cover if they don't.
  if (globalThis.opener !== null) {
    globalThis.opener = null;
    globalThis.location.reload();
    return;
  }

  const params = new URLSearchParams(globalThis.location.search);

  // Make it easy to re-open as a window.
  const openas = params.get('openas');
  switch (openas) {
    case 'window': {
      // Delete the 'openas' string so we don't get into a loop.  We want to
      // preserve the rest of the query string when opening the window.
      params.delete('openas');
      const url = new URL(globalThis.location.toString());
      url.search = params.toString();
      Crosh.openNewWindow_(url.href).then(() => globalThis.close());
      return;
    }

    case 'fullscreen':
    case 'maximized':
      chrome.windows.getCurrent({populate: true}, (win) => {
        if (win.tabs.length > 1) {
          // If the current window has multiple tabs, create a new window and
          // move this tab to it.  This avoids confusion if the current window
          // has non-secure shell tabs in it.
          chrome.tabs.getCurrent((tab) => {
            chrome.windows.create({
              focused: win.focused,
              state: openas,
              tabId: tab.id,
            });
          });
        } else {
          // If the current window only has 1 tab, reuse the window.
          chrome.windows.update(win.id, {state: openas});
        }
      });
      break;
  }

  disableTabDiscarding();

  await setupForWebApp();

  Crosh.init();
});

/**
 * The Crosh-powered terminal command.
 *
 * This class defines a command that can be run in an hterm.Terminal instance.
 * The Crosh command uses terminalPrivate extension API to create and use crosh
 * process on ChromeOS machine.
 *
 * @param {{
 *   commandName: string,
 *   terminal: !hterm.Terminal,
 *   args: !Array<string>,
 *   onExit: function(),
 * }} argv The argument object passed in from the Terminal.
 * @constructor
 */
function Crosh({commandName, terminal, args, onExit}) {
  this.commandName = commandName;
  this.terminal = terminal;
  this.io = terminal.io;
  this.args = args;
  this.onExit_ = onExit;
  this.id_ = null;
  this.disposed_ = false;
  this.outputListener_ = this.onProcessOutput_.bind(this);
  this.prefListener_ = null;
}

/**
 * Return a formatted message in the current locale.
 *
 * @param {string} name The name of the message to return.
 * @param {!Array=} args The message arguments, if required.
 * @return {string} The localized & formatted message.
 */
Crosh.msg = function(name, args) {
  return hterm.messageManager.get(name, args);
};

/**
 * Static initializer called from crosh.html.
 *
 * Creates the initial Crosh session and wires the split controls.
 *
 * @return {boolean}
 */
Crosh.init = function() {
  const params = new URLSearchParams(globalThis.location.search);
  const profileId = params.get('profile');
  const args = params.getAll('args[]');
  const storage = getSyncStorage();
  const container = lib.notNull(document.querySelector('#terminal'));
  const divider = lib.notNull(container.querySelector('.crosh-divider'));
  installSplitResize(container, divider);
  const panes = [];

  const updateTitle = () => {
    document.title = panes.map(({title}) => title).join(' | ');
  };

  const updatePanes = () => {
    const split = panes.length === 2;
    divider.hidden = !split;
    for (const pane of panes) {
      pane.crosh.setContextMenu_(split ?
        {name: 'Close pane', action: () => closePane(pane)} :
        {name: 'Split right', action: addPane});
    }
    updateTitle();
  };

  function closePane(pane) {
    const index = panes.indexOf(pane);
    if (index === -1) {
      return;
    }
    if (panes.length === 1) {
      globalThis.close();
      return;
    }
    panes.splice(index, 1);
    pane.crosh.dispose_();
    pane.element.remove();
    updatePanes();
    globalThis.term_ = panes[0].crosh.terminal;
    globalThis.term_.focus();
  }

  function addPane() {
    if (panes.length === 2) {
      return;
    }
    const element = document.createElement('div');
    element.className = 'crosh-pane';
    container.appendChild(divider);
    container.appendChild(element);
    const terminal = new hterm.Terminal({profileId, storage});
    const crosh = new Crosh({
      commandName: 'crosh', terminal, args, onExit: () => closePane(pane),
    });
    const pane = {element, crosh, title: 'crosh'};
    panes.push(pane);
    terminal.setWindowTitle = (title) => {
      pane.title = title;
      updateTitle();
    };
    pane.crosh.attach_(element);
    globalThis.term_ = terminal;
    updatePanes();
  }

  globalThis.onbeforeunload = (e) => {
    const live = panes.find(({crosh}) => crosh.id_ !== null);
    return live?.crosh.onBeforeUnload_(e);
  };
  globalThis.addEventListener('unload', () => {
    panes.forEach(({crosh}) => crosh.dispose_());
  });
  addPane();
  return true;
};

function installSplitResize(container, divider) {
  const minShare = 15;
  const maxShare = 100 - minShare;
  const keyStep = 5;
  let share = 50;
  let grabOffset = 0;

  function resize(nextShare) {
    share = Math.max(minShare, Math.min(maxShare, nextShare));
    container.style.setProperty('--left-pane-share', String(share));
    divider.setAttribute('aria-valuenow', String(Math.round(share)));
  }

  divider.setAttribute('aria-valuemin', String(minShare));
  divider.setAttribute('aria-valuemax', String(maxShare));
  resize(share);

  divider.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary) {
      return;
    }
    grabOffset = e.clientX - divider.getBoundingClientRect().left;
    divider.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  divider.addEventListener('pointermove', (e) => {
    if (!divider.hasPointerCapture(e.pointerId)) {
      return;
    }
    const width = container.clientWidth - divider.offsetWidth;
    if (width > 0) {
      const left = e.clientX - container.getBoundingClientRect().left;
      resize(100 * (left - grabOffset) / width);
    }
  });
  divider.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowLeft':
        resize(share - keyStep);
        break;
      case 'ArrowRight':
        resize(share + keyStep);
        break;
      case 'Home':
        resize(minShare);
        break;
      case 'End':
        resize(maxShare);
        break;
      default:
        return;
    }
    e.preventDefault();
  });
}

Crosh.prototype.attach_ = function(element) {
  const terminal = this.terminal;
  // Use legacy pasting when running as an extension to avoid prompt.
  // TODO(crbug.com/1063219) We need this to not prompt the user for clipboard
  // permission.
  terminal.alwaysUseLegacyPasting = !isCrOSSystemApp();

  terminal.decorate(element);
  terminal.installKeyboard();
  const runCrosh = () => {
    if (this.disposed_) {
      return;
    }
    terminal.keyboard.bindings.addBinding('Ctrl+Shift+P', function() {
      openOptionsPage();
      return hterm.Keyboard.KeyActions.CANCEL;
    });

    terminal.onOpenOptionsPage = openOptionsPage;
    terminal.setCursorPosition(0, 0);
    terminal.setCursorVisible(true);
    this.run();
  };
  terminal.onTerminalReady = () => {
    if (this.disposed_) {
      return;
    }
    terminal.onFreconBox = (args) => drawFreconBox(terminal.getDocument(), args);
    terminal.freconInputEnabled = true;
    terminal.allowImagesInline = true;
    terminal.getPrefs().addObserver('allow-images-inline', () => {
      terminal.allowImagesInline = true;
    });
    loadWebFonts(terminal.getDocument());

    // TODO(b/223076712): Avoid errors for nassh-crosh running on pre-M101.
    // Can be removed when stable is M101+.
    if (!chrome.terminalPrivate?.getPrefs) {
      runCrosh();
      return;
    }

    const prefKey = 'settings.accessibility';
    this.prefListener_ = (prefs) => {
      if (prefs.hasOwnProperty(prefKey)) {
        terminal.setAccessibilityEnabled(prefs[prefKey]);
      }
    };
    chrome.terminalPrivate.onPrefChanged.addListener(this.prefListener_);
    chrome.terminalPrivate.getPrefs([prefKey], (prefs) => {
      if (!this.disposed_) {
        this.prefListener_(prefs);
        runCrosh();
      }
    });
  };
};

Crosh.prototype.setContextMenu_ = function(paneItem) {
  const terminal = this.terminal;
  terminal.contextMenu.setItems([
    {name: Crosh.msg('TERMINAL_CLEAR_MENU_LABEL'),
     action: function() {
       terminal.getDocument().getElementById('crosh-boxes')?.remove();
       terminal.wipeContents();
     }},
    {name: Crosh.msg('TERMINAL_RESET_MENU_LABEL'),
     action: function() {
       terminal.getDocument().getElementById('crosh-boxes')?.remove();
       terminal.freconInputEnabled = true;
       terminal.reset();
     }},
    {name: Crosh.msg('NEW_WINDOW_MENU_LABEL'),
     action: function() {
       // Preserve the full URI in case it has args like for vmshell.
       Crosh.openNewWindow_(globalThis.location.href);
     }},
    paneItem,
    {name: Crosh.msg('FAQ_MENU_LABEL'),
     action: function() {
       lib.f.openWindow('https://hterm.org/x/ssh/faq', '_blank');
     }},
    {name: Crosh.msg('HTERM_OPTIONS_BUTTON_LABEL'),
     action: function() { openOptionsPage(); }},
    {name: Crosh.msg('SEND_FEEDBACK_LABEL'),
     action: sendFeedback},
  ]);
};

function drawFreconBox(doc, args) {
  let size = [1, 1];
  let location;
  let offset = [0, 0];
  let color = 0;
  let scale = 1;
  for (const arg of args.split(';')) {
    const [key, text] = arg.split('=', 2);
    switch (key) {
      case 'size':
      case 'location':
      case 'offset': {
        const pair = text?.match(/^\s*([+-]?\d+),\s*([+-]?\d+)\s*$/);
        if (!pair) {
          return;
        }
        const point = pair.slice(1).map(Number);
        if (key === 'offset') {
          offset = point.map((n) => n | 0);
        } else if (key === 'location') {
          location = point.map((n) => n >>> 0);
        } else {
          size = point.map((n) => n >>> 0);
        }
        break;
      }
      case 'color': {
        const packed = text?.trim().match(
            /^([+-]?)(0x[\da-f]+|0[0-7]*|[1-9]\d*)$/i);
        if (!packed) {
          return;
        }
        const digits = packed[2];
        const magnitude = /^0[0-7]/.test(digits) ?
          parseInt(digits, 8) : Number(digits);
        color = (packed[1] === '-' ? -magnitude : magnitude) >>> 0;
        break;
      }
      case 'scale':
        if (!text || !/^\s*[+-]?\d+\s*$/.test(text)) {
          return;
        }
        scale = Number(text) >>> 0;
        break;
    }
  }

  const ratio = doc.defaultView.devicePixelRatio;
  const width = Math.round(doc.documentElement.clientWidth * ratio);
  const height = Math.round(doc.documentElement.clientHeight * ratio);
  scale ||= width > 2048 || height > 2048 ? 2 : 1;
  const [w, h] = size.map((n) => n * scale);
  const [x, y] = location ?? [
    Math.trunc((width - w) / 2) + offset[0] * scale,
    Math.trunc((height - h) / 2) + offset[1] * scale,
  ];

  let canvas = doc.getElementById('crosh-boxes');
  if (!canvas) {
    canvas = doc.createElement('canvas');
    canvas.id = 'crosh-boxes';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText =
        'position:fixed;inset:0;width:100%;height:100%;pointer-events:none';
    doc.body.appendChild(canvas);
  }
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d');
  const rgb = (color & 0xffffff).toString(16).padStart(6, '0');
  const alpha = (color >>> 24).toString(16).padStart(2, '0');
  context.fillStyle = `#${rgb}${alpha}`;
  context.fillRect(x, y, w, h);
}

/**
 * Open a new session in a window.
 *
 * We use chrome.windows.create instead of lib.f.openWindow as the latter
 * might not always have permission to create a new window w/chrome=no.
 *
 * We can't rely on the background page all the time (like nassh_main.js) as we
 * might be executing as a bundled extension which doesn't have a background
 * page at all.
 *
 * @param {string} url The URL to open.
 * @return {!Promise} A promise resolving once the window opens.
 */
Crosh.openNewWindow_ = function(url) {
  return new Promise((resolve) => {
    chrome.windows.create({
      url: url,
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
      focused: true,
      type: 'popup',
    }, resolve);
  });
};

/**
 * Called when an event from the crosh process is detected.
 *
 * @param {string} id Id of the process the event came from.
 * @param {string} type Type of the event.
 *             'stdout': Process output detected.
 *             'exit': Process has exited.
 * @param {string|!ArrayBuffer} data Data that was detected on process output.
 */
Crosh.prototype.onProcessOutput_ = function(id, type, data) {
  if (this.id_ === null || id !== this.id_) {
    return;
  }

  if (type == 'exit') {
    this.exit(0);
    return;
  }
  if (data instanceof ArrayBuffer) {
    this.io.writeUTF8(data);
  } else {
    // Older version of terminal private api gives strings.
    //
    // TODO(1260289): Remove this.
    this.io.print(data);
  }
};

/**
 * Start the crosh command.
 */
Crosh.prototype.run = function() {
  // We're not currently a window, so show a message to the user with a link to
  // open as a new window.
  if (hterm.windowType !== 'app' &&
      hterm.windowType !== 'popup' &&
      !isCrOSSystemApp()) {
    const params = new URLSearchParams(globalThis.location.search);
    params.set('openas', 'window');
    const url = new URL(globalThis.location.toString());
    url.search = params.toString();
    this.io.println(Crosh.msg(
        'OPEN_AS_WINDOW_TIP',
        [sgrText(osc8Link(url.href, '[crosh]'), {bold: true})]));
    this.io.println('');
  }

  if (!chrome.terminalPrivate) {
    this.io.println(Crosh.msg('COMMAND_NOT_SUPPORTED', [this.commandName]));
    this.exit(1);
    return;
  }

  this.io.onVTKeystroke = this.io.sendString = this.sendString_.bind(this);

  this.io.onTerminalResize = this.onTerminalResize_.bind(this);
  chrome.terminalPrivate.onProcessOutput.addListener(this.outputListener_);

  const pidInit = (id) => {
    if (this.disposed_) {
      if (id !== undefined) {
        chrome.terminalPrivate.closeTerminalProcess(id);
      }
      return;
    }
    if (id === undefined) {
      this.io.println(Crosh.msg('COMMAND_STARTUP_FAILED',
                                [this.commandName, lib.f.lastError('')]));
      this.exit(1);
      return;
    }

    this.id_ = id;

    // Setup initial window size.
    this.onTerminalResize_(this.io.terminal_.screenSize.width,
                           this.io.terminal_.screenSize.height);
  };

  chrome.terminalPrivate.openTerminalProcess(
      this.commandName, this.args, pidInit);
};

/**
 * Registers with window.onbeforeunload and runs when page is unloading.
 *
 * @param {?Event} e Before unload event.
 * @return {string} Message to display.
 */
Crosh.prototype.onBeforeUnload_ = function(e) {
  // Note: This message doesn't seem to be shown by browsers.
  const msg = `Closing this tab will exit ${this.commandName}.`;
  e.returnValue = msg;
  return msg;
};

/**
 * Send a string to the crosh process.
 *
 * @param {string} string The string to send.
 */
Crosh.prototype.sendString_ = function(string) {
  if (this.id_ === null) {
    return;
  }
  chrome.terminalPrivate.sendInput(this.id_, string);
};

/**
 * Closes crosh terminal and exits the crosh command.
 */
Crosh.prototype.close_ = function() {
  chrome.terminalPrivate?.onProcessOutput.removeListener(this.outputListener_);
  if (this.id_ === null) {
    return;
  }
  chrome.terminalPrivate.closeTerminalProcess(this.id_);
  this.id_ = null;
};

Crosh.prototype.dispose_ = function() {
  this.disposed_ = true;
  this.close_();
  if (this.prefListener_) {
    chrome.terminalPrivate.onPrefChanged.removeListener(this.prefListener_);
    this.prefListener_ = null;
  }
  this.terminal.getPrefs().stopObservingStorage();
  this.terminal.setCursorBlink(false);
  this.terminal.uninstallKeyboard();
};

/**
 * Notify process about new terminal size.
 *
 * @param {string|number} width The new terminal width.
 * @param {string|number} height The new terminal height.
 */
Crosh.prototype.onTerminalResize_ = function(width, height) {
  if (this.id_ === null) {
    return;
  }

  chrome.terminalPrivate.onTerminalResize(this.id_,
      Number(width), Number(height),
      function(success) {
        if (!success) {
          console.warn('terminalPrivate.onTerminalResize failed');
        }
      },
  );
};

/**
 * Exit the crosh command.
 *
 * @param {number} code Exit code, 0 for success.
 */
Crosh.prototype.exit = function(code) {
  this.close_();

  const onExit = () => {
    if (this.terminal.getPrefs().get('close-on-exit')) {
      this.onExit_();
    }
  };

  if (code == 0) {
    onExit();
    return;
  }

  this.io.println(Crosh.msg('COMMAND_COMPLETE', [this.commandName, code]));
  this.io.println(Crosh.msg('RECONNECT_MESSAGE'));
  this.io.onVTKeystroke = (string) => {
    const ch = string.toLowerCase();
    if (ch == 'r' || ch == ' ' || ch == '\x0d' /* enter */ ||
        ch == '\x12' /* ctrl-r */) {
      this.terminal.freconInputEnabled = true;
      this.run();
      return;
    }

    if (ch == 'c') {
      globalThis.location.replace('/html/nassh_connect_dialog.html');
      return;
    }

    if (ch == 'e' || ch == 'x' || ch == '\x1b' /* ESC */ ||
        ch == '\x17' /* C-w */) {
      onExit();
    }
  };
};
