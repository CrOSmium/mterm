export class Base64Decoder {
  init(size) {
    this.size_ = size;
    this.length_ = 0;
    this.chunks_ = [];
    this.data8 = new Uint8Array(0);
  }

  put(data, start, end) {
    if (this.length_ + end - start > Math.ceil(this.size_ / 3) * 4) {
      return 1;
    }
    let text = '';
    for (let i = start; i < end; ++i) {
      if (data[i] > 127) {
        return 1;
      }
      text += String.fromCharCode(data[i]);
    }
    this.chunks_.push(text);
    this.length_ += end - start;
    return 0;
  }

  end() {
    try {
      const text = this.chunks_.join('');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
        return 1;
      }
      const decoded = atob(text);
      if (decoded.length !== this.size_) {
        return 1;
      }
      this.data8 = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
      return 0;
    } catch {
      return 1;
    } finally {
      this.chunks_ = [];
    }
  }

  release() {
    this.chunks_ = [];
    this.data8 = new Uint8Array(0);
  }
}
