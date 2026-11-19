export class CroshPanes {
  constructor(container, launchInfo, init) {
    this.container_ = container;
    this.launchInfo_ = launchInfo;
    this.init_ = init;
    this.panes_ = [];
    this.share_ = 50;
    container.classList.add('crosh-split');
    this.divider_ = document.createElement('div');
    this.divider_.className = 'crosh-divider';
    this.divider_.setAttribute('role', 'separator');
    this.divider_.setAttribute('aria-label', 'Resize panes');
    this.divider_.setAttribute('aria-orientation', 'vertical');
    this.divider_.setAttribute('aria-valuemin', '15');
    this.divider_.setAttribute('aria-valuemax', '85');
    this.divider_.tabIndex = 0;
    this.divider_.hidden = true;
    let grabOffset = 0;
    this.divider_.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !e.isPrimary) {
        return;
      }
      grabOffset = e.clientX - this.divider_.getBoundingClientRect().left;
      this.divider_.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.divider_.addEventListener('pointermove', (e) => {
      if (!this.divider_.hasPointerCapture(e.pointerId)) {
        return;
      }
      const width = container.clientWidth - this.divider_.offsetWidth;
      if (width > 0) {
        const left = e.clientX - container.getBoundingClientRect().left;
        this.resize_(100 * (left - grabOffset) / width);
      }
    });
    this.divider_.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowLeft': this.resize_(this.share_ - 5); break;
        case 'ArrowRight': this.resize_(this.share_ + 5); break;
        case 'Home': this.resize_(15); break;
        case 'End': this.resize_(85); break;
        default: return;
      }
      e.preventDefault();
    });
    window.addEventListener('beforeunload', (e) => {
      if (this.panes_.some((pane) => pane.command?.running_)) {
        e.returnValue = '';
      }
    });
    window.addEventListener('unload', () => {
      this.panes_.forEach((pane) => pane.command?.close_());
    });
  }

  resize_(share) {
    this.share_ = Math.max(15, Math.min(85, share));
    this.divider_.setAttribute(
        'aria-valuenow', String(Math.round(this.share_)));
    this.panes_.filter((pane) => pane.active).forEach((pane, index) => {
      pane.element.style.flexGrow =
          String(index ? 100 - this.share_ : this.share_);
    });
  }

  update_() {
    const active = this.panes_.filter((pane) => pane.active);
    this.divider_.hidden = active.length !== 2;
    for (const pane of active) {
      if (pane.term) {
        pane.term.contextMenu.setItems([...pane.menuItems,
          active.length === 2 ?
            {name: 'Close pane', action: () => this.close_(pane)} :
            {name: 'Split right', action: () => this.add()},
        ]);
      }
    }
    this.resize_(this.share_);
    document.title = active.map((pane) => pane.title).join(' | ');
  }

  close_(pane) {
    if (!pane.active) {
      return;
    }
    pane.active = false;
    pane.command?.close_();
    pane.term?.clearFrecon?.(true);
    pane.element.hidden = true;
    const next = this.panes_.find((p) => p.active);
    if (!next) {
      window.close();
      return;
    }
    this.update_();
    window.term_ = next.term;
    next.term?.focus();
  }

  async add() {
    if (this.panes_.filter((pane) => pane.active).length === 2) {
      return;
    }
    let pane = this.panes_.find((p) => !p.active);
    if (!pane) {
      pane = {element: document.createElement('div'), title: 'crosh'};
      pane.element.className = 'crosh-pane';
      pane.close = () => this.close_(pane);
      this.panes_.push(pane);
    }
    this.panes_.splice(this.panes_.indexOf(pane), 1);
    this.panes_.push(pane);
    pane.title = 'crosh';
    pane.active = true;
    pane.element.hidden = false;
    this.container_.append(this.divider_, pane.element);
    this.update_();
    if (!pane.term) {
      const term = await this.init_(pane.element, this.launchInfo_, pane);
      term.setWindowTitle = (title) => {
        pane.title = title;
        this.update_();
      };
    } else if (pane.command) {
      pane.term.clearFrecon(true);
      pane.term.reset();
      pane.command.run(this.launchInfo_);
    }
    if (pane.active) {
      window.term_ = pane.term;
      pane.term.focus();
    }
    this.update_();
  }
}

export function enableFrecon(term, element) {
  term.freconInputEnabled = true;
  term.allowImagesInline = true;
  term.getPrefs().addObserver('allow-images-inline', () => {
    term.allowImagesInline = true;
  });
  const container = () => term.term ? element : term.getDocument()?.body;
  term.onFreconBox = (args) => drawFreconBox(container(), args);
  term.clearFrecon = (resetInput = false) => {
    container()?.querySelector('.crosh-boxes')?.remove();
    if (resetInput) {
      term.freconInputEnabled = true;
    }
  };
}

function drawFreconBox(container, args) {
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
  const ratio = container.ownerDocument.defaultView.devicePixelRatio;
  const width = Math.round(container.clientWidth * ratio);
  const height = Math.round(container.clientHeight * ratio);
  scale ||= width > 2048 || height > 2048 ? 2 : 1;
  const [w, h] = size.map((n) => n * scale);
  const [x, y] = location ?? [
    Math.trunc((width - w) / 2) + offset[0] * scale,
    Math.trunc((height - h) / 2) + offset[1] * scale,
  ];
  let canvas = container.querySelector('.crosh-boxes');
  if (!canvas) {
    canvas = container.ownerDocument.createElement('canvas');
    canvas.className = 'crosh-boxes';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;' +
        'pointer-events:none;z-index:5';
    container.appendChild(canvas);
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
