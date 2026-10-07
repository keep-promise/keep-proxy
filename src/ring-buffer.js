'use strict';

/** 固定容量的内存环形缓冲，用于请求日志 */
class RingBuffer {
  constructor(limit = 500) {
    this.limit = limit;
    this.buf = [];
  }

  add(item) {
    this.buf.push(item);
    if (this.buf.length > this.limit) {
      this.buf.splice(0, this.buf.length - this.limit);
    }
    return item;
  }

  list() {
    return this.buf.slice().reverse();
  }

  clear() {
    this.buf = [];
  }

  get length() {
    return this.buf.length;
  }
}

module.exports = { RingBuffer };
