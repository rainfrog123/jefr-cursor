var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "node_modules/ws/lib/constants.js"(exports2, module2) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob)
      BINARY_TYPES.push("blob");
    module2.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: Symbol("kIsForOnEventAttribute"),
      kListener: Symbol("kListener"),
      kStatusCode: Symbol("status-code"),
      kWebSocket: Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "node_modules/ws/lib/buffer-util.js"(exports2, module2) {
    "use strict";
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0)
        return EMPTY_BUFFER;
      if (list.length === 1)
        return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length) {
      for (let i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data))
        return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module2.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = require("bufferutil");
        module2.exports.mask = function(source, mask, output, offset, length) {
          if (length < 48)
            _mask(source, mask, output, offset, length);
          else
            bufferUtil.mask(source, mask, output, offset, length);
        };
        module2.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32)
            _unmask(buffer, mask);
          else
            bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "node_modules/ws/lib/limiter.js"(exports2, module2) {
    "use strict";
    var kDone = Symbol("kDone");
    var kRun = Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency)
          return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module2.exports = Limiter;
  }
});

// node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "node_modules/ws/lib/permessage-deflate.js"(exports2, module2) {
    "use strict";
    var zlib = require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = Symbol("permessage-deflate");
    var kTotalLength = Symbol("total-length");
    var kCallback = Symbol("callback");
    var kBuffers = Symbol("buffers");
    var kError = Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate2 = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {Boolean} [options.isServer=false] Create the instance in either
       *     server or client mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       */
      constructor(options) {
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._maxPayload = this._options.maxPayload | 0;
        this._isServer = !!this._options.isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && !params.client_max_window_bits) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key) => {
            let value = params[key];
            if (value.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value = value[0];
            if (key === "client_max_window_bits") {
              if (value !== true) {
                const num = +value;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value}`
                  );
                }
                value = num;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num = +value;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
              value = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params[key] = value;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin)
          this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module2.exports = PerMessageDeflate2;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "node_modules/ws/lib/validation.js"(exports2, module2) {
    "use strict";
    var { isUtf8 } = require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value) {
      return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
    }
    module2.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module2.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = require("utf-8-validate");
        module2.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "node_modules/ws/lib/receiver.js"(exports2, module2) {
    "use strict";
    var { Writable } = require("stream");
    var PerMessageDeflate2 = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver2 = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxBufferedChunks = options.maxBufferedChunks | 0;
        this._maxFragments = options.maxFragments | 0;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO)
          return cb();
        if (this._maxBufferedChunks > 0 && this._buffers.length >= this._maxBufferedChunks) {
          cb(
            this.createError(
              RangeError,
              "Too many buffered chunks",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            )
          );
          return;
        }
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length)
          return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored)
          cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate2.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented)
          this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126)
          this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127)
          this._state = GET_PAYLOAD_LENGTH_64;
        else
          this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked)
          this._state = GET_MASK;
        else
          this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          if (this._maxFragments > 0 && this._fragments.length >= this._maxFragments) {
            const error = this.createError(
              RangeError,
              "Too many message fragments",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            );
            cb(error);
            return;
          }
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err)
            return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            if (this._maxFragments > 0 && this._fragments.length >= this._maxFragments) {
              const error = this.createError(
                RangeError,
                "Too many message fragments",
                false,
                1008,
                "WS_ERR_TOO_MANY_BUFFERED_PARTS"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO)
            this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module2.exports = Receiver2;
  }
});

// node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "node_modules/ws/lib/sender.js"(exports2, module2) {
    "use strict";
    var { Duplex } = require("stream");
    var { randomFillSync } = require("crypto");
    var {
      types: { isUint8Array }
    } = require("util");
    var PerMessageDeflate2 = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender2 = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1)
          target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask)
          return [target, data];
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (skipMasking)
          return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else if (isUint8Array(data)) {
            buf.set(data, 2);
          } else {
            throw new TypeError("Second argument must be a string or a Uint8Array");
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin)
          this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module2.exports = Sender2;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function")
        cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function")
          callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "node_modules/ws/lib/event-target.js"(exports2, module2) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = Symbol("kCode");
    var kData = Symbol("kData");
    var kError = Symbol("kError");
    var kMessage = Symbol("kMessage");
    var kReason = Symbol("kReason");
    var kTarget = Symbol("kTarget");
    var kType = Symbol("kType");
    var kWasClean = Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module2.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "node_modules/ws/lib/extension.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0)
        dest[name] = [elem];
      else
        dest[name].push(elem);
    }
    function parse(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1)
              start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1)
              end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1)
              end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1)
              start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1)
              end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1)
              end = i;
            push(params, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1)
              start = i;
            else if (!mustUnescape)
              mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1)
                start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1)
              start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1)
              end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1)
              end = i;
            let value = header.slice(start, end);
            if (mustUnescape) {
              value = value.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1)
        end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params);
      } else {
        if (paramName === void 0) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension2) => {
        let configurations = extensions[extension2];
        if (!Array.isArray(configurations))
          configurations = [configurations];
        return configurations.map((params) => {
          return [extension2].concat(
            Object.keys(params).map((k) => {
              let values = params[k];
              if (!Array.isArray(values))
                values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module2.exports = { format, parse };
  }
});

// node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "node_modules/ws/lib/websocket.js"(exports2, module2) {
    "use strict";
    var EventEmitter2 = require("events");
    var https = require("https");
    var http3 = require("http");
    var net = require("net");
    var tls = require("tls");
    var { randomBytes, createHash: createHash3 } = require("crypto");
    var { Duplex, Readable } = require("stream");
    var { URL } = require("url");
    var PerMessageDeflate2 = require_permessage_deflate();
    var Receiver2 = require_receiver();
    var Sender2 = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener, removeEventListener }
    } = require_event_target();
    var { format, parse } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket2 = class _WebSocket extends EventEmitter2 {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            protocols = [];
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              protocols = [];
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type))
          return;
        this._binaryType = type;
        if (this._receiver)
          this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket)
          return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver2({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxBufferedChunks: options.maxBufferedChunks,
          maxFragments: options.maxFragments,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender2(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout)
          socket.setTimeout(0);
        if (socket.setNoDelay)
          socket.setNoDelay();
        if (head.length > 0)
          socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate2.extensionName]) {
          this._extensions[PerMessageDeflate2.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED)
          return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._readyState = _WebSocket.CLOSING;
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err)
            return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number")
          data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0)
          mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number")
          data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0)
          mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain)
          this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number")
          data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate2.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED)
          return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket2, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket2.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket2.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute])
              return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function")
            return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket2.prototype.addEventListener = addEventListener;
    WebSocket2.prototype.removeEventListener = removeEventListener;
    module2.exports = WebSocket2;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxBufferedChunks: 1024 * 1024,
        maxFragments: 128 * 1024,
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL(address);
        } catch {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes(16).toString("base64");
      const request = isSecure ? https.request : http3.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate2({
          ...opts.perMessageDeflate,
          isServer: false,
          maxPayload: opts.maxPayload
        });
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate2.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const parts = opts.path.split(":");
        opts.socketPath = parts[0];
        opts.path = parts[1];
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost)
              delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted])
          return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode;
        if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL(location, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket2.CONNECTING)
          return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash3("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt)
          websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate2.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate2.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxBufferedChunks: opts.maxBufferedChunks,
          maxFragments: opts.maxFragments,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket2.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket2.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket)
          websocket._sender._bufferedBytes += length;
        else
          websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0)
        return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005)
        websocket.close();
      else
        websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused)
        websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong)
        websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket2.CLOSED)
        return;
      if (websocket.readyState === WebSocket2.OPEN) {
        websocket._readyState = WebSocket2.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket2.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket2.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket2.CLOSING;
        this.destroy();
      }
    }
  }
});

// node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "node_modules/ws/lib/stream.js"(exports2, module2) {
    "use strict";
    var WebSocket2 = require_websocket();
    var { Duplex } = require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream2(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data))
          ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed)
          return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed)
          return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called)
            callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy)
          ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null)
          return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted)
            duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused)
          ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module2.exports = createWebSocketStream2;
  }
});

// node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "node_modules/ws/lib/subprotocol.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1)
            start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1)
            end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1)
            end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module2.exports = { parse };
  }
});

// node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "node_modules/ws/lib/websocket-server.js"(exports2, module2) {
    "use strict";
    var EventEmitter2 = require("events");
    var http3 = require("http");
    var { Duplex } = require("stream");
    var { createHash: createHash3 } = require("crypto");
    var extension2 = require_extension();
    var PerMessageDeflate2 = require_permessage_deflate();
    var subprotocol2 = require_subprotocol();
    var WebSocket2 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter2 {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxBufferedChunks=1048576] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=131072] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxBufferedChunks: 1024 * 1024,
          maxFragments: 128 * 1024,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket2,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http3.createServer((req, res) => {
            const body = http3.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true)
          options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server)
          return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb)
          this.once("close", cb);
        if (this._state === CLOSING)
          return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server2 = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server2.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path)
            return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol2.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate2({
            ...this.options.perMessageDeflate,
            isServer: true,
            maxPayload: this.options.maxPayload
          });
          try {
            const offers = extension2.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate2.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate2.extensionName]);
              extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info))
            return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable)
          return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING)
          return abortHandshake(socket, 503);
        const digest = createHash3("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate2.extensionName]) {
          const params = extensions[PerMessageDeflate2.extensionName].params;
          const value = extension2.format({
            [PerMessageDeflate2.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxBufferedChunks: this.options.maxBufferedChunks,
          maxFragments: this.options.maxFragments,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module2.exports = WebSocketServer2;
    function addListeners(server2, map) {
      for (const event of Object.keys(map))
        server2.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server2.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server2) {
      server2._state = CLOSED;
      server2.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http3.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http3.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server2, req, socket, code, message, headers) {
      if (server2.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server2.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode = __toESM(require("vscode"));
var path3 = __toESM(require("path"));
var fs3 = __toESM(require("fs"));
var os3 = __toESM(require("os"));
var crypto2 = __toESM(require("crypto"));
var import_child_process = require("child_process");

// src/messenger.ts
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var os = __toESM(require("os"));
var ROOT_DATA_DIR = path.join(os.homedir(), ".moyu-message");
var dataDir = process.env.MESSENGER_DATA_DIR || ROOT_DATA_DIR;
var QUEUE_FILE = path.join(dataDir, "queue.json");
var QUESTION_FILE = path.join(dataDir, "question.json");
var ANSWER_FILE = path.join(dataDir, "answer.json");
var REPLY_FILE = path.join(dataDir, "reply.json");
var CARD_FILE = path.join(dataDir, "card.json");
var INJECTED_TOKEN_FILE = path.join(dataDir, "injected-token.json");
var HISTORY_FILE = path.join(dataDir, "history.json");
var HEARTBEAT_FILE = path.join(dataDir, "agent-alive.json");
var QUEUE_LOCK_DIR = path.join(dataDir, "queue.lock");
var RULES_FILE_NAME = "mcp-messenger.mdc";
var LEGACY_RULES_FILE_NAME = "system.mdc";
function selectedAgentFile() {
  return path.join(dataDir, "selected-agent.json");
}
function readSelectedAgentId() {
  const file = selectedAgentFile();
  if (!fs.existsSync(file)) {
    return void 0;
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    const id = typeof data.agentId === "string" ? sanitizeAgentId(data.agentId) : "";
    return id || void 0;
  } catch {
    return void 0;
  }
}
function writeSelectedAgentId(agentId) {
  ensureDir();
  const file = selectedAgentFile();
  if (!agentId) {
    try {
      fs.unlinkSync(file);
    } catch {
    }
    return;
  }
  fs.writeFileSync(
    file,
    JSON.stringify({ agentId: sanitizeAgentId(agentId), timestamp: (/* @__PURE__ */ new Date()).toISOString() }),
    "utf-8"
  );
}
function setDataDir(dir) {
  dataDir = dir;
  QUEUE_FILE = path.join(dir, "queue.json");
  QUESTION_FILE = path.join(dir, "question.json");
  ANSWER_FILE = path.join(dir, "answer.json");
  REPLY_FILE = path.join(dir, "reply.json");
  CARD_FILE = path.join(dir, "card.json");
  INJECTED_TOKEN_FILE = path.join(dir, "injected-token.json");
  HISTORY_FILE = path.join(dir, "history.json");
  HEARTBEAT_FILE = path.join(dir, "agent-alive.json");
  QUEUE_LOCK_DIR = path.join(dir, "queue.lock");
}
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
    }
  }
}
function acquireQueueLock(timeoutMs = 2e3) {
  const start = Date.now();
  for (; ; ) {
    try {
      fs.mkdirSync(QUEUE_LOCK_DIR);
      return true;
    } catch {
      try {
        const st = fs.statSync(QUEUE_LOCK_DIR);
        if (Date.now() - st.mtimeMs > 5e3) {
          try {
            fs.rmdirSync(QUEUE_LOCK_DIR);
          } catch {
          }
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        return false;
      }
      sleepSync(8);
    }
  }
}
function releaseQueueLock() {
  try {
    fs.rmdirSync(QUEUE_LOCK_DIR);
  } catch {
  }
}
function withQueueLock(fn) {
  ensureDir();
  const locked = acquireQueueLock();
  try {
    return fn();
  } finally {
    if (locked) {
      releaseQueueLock();
    }
  }
}
function robustWriteFile(file, data) {
  let lastErr;
  for (let i = 0; i < 10; i++) {
    try {
      fs.writeFileSync(file, data, "utf-8");
      return;
    } catch (e) {
      lastErr = e;
      const code = e?.code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") {
        throw e;
      }
      sleepSync(15);
    }
  }
  if (lastErr) {
    throw lastErr;
  }
}
var AGENT_STALE_MS = 6e3;
function getAgentStatusFor(agentId) {
  const file = path.join(agentDirFor(agentId), "agent-alive.json");
  try {
    if (!fs.existsSync(file)) {
      return { alive: false, state: "idle" };
    }
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    const ts = typeof data.ts === "number" ? data.ts : 0;
    if (Date.now() - ts >= AGENT_STALE_MS) {
      return { alive: false, state: "idle" };
    }
    const state = data.state === "working" ? "working" : "waiting";
    return { alive: true, state };
  } catch {
    return { alive: false, state: "idle" };
  }
}
var HISTORY_CAP = 150;
function readSharedHistory() {
  ensureDir();
  if (!fs.existsSync(HISTORY_FILE)) {
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
function appendSharedHistory(item) {
  try {
    const hist = readSharedHistory();
    if (hist.some((existing) => existing.id === item.id)) {
      return;
    }
    hist.push(item);
    if (hist.length > HISTORY_CAP) {
      hist.splice(0, hist.length - HISTORY_CAP);
    }
    ensureDir();
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(hist, null, 2), "utf-8");
  } catch {
  }
}
function appendReplyToSharedHistory(reply) {
  if (!reply.content || typeof reply.percent === "number") {
    return;
  }
  const timestamp = reply.timestamp || (/* @__PURE__ */ new Date()).toISOString();
  appendSharedHistory({
    id: "reply-" + timestamp,
    kind: "reply",
    text: reply.content,
    timestamp
  });
}
function migrateFromRootDir() {
  if (dataDir === ROOT_DATA_DIR) {
    return;
  }
  const rootCardFile = path.join(ROOT_DATA_DIR, "card.json");
  if (fs.existsSync(rootCardFile) && !fs.existsSync(CARD_FILE)) {
    ensureDir();
    fs.copyFileSync(rootCardFile, CARD_FILE);
  }
}
var REMOTE_API_ENABLED = false;
function ensureDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}
function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function readQueue() {
  ensureDir();
  if (!fs.existsSync(QUEUE_FILE)) {
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
function writeQueue(items) {
  ensureDir();
  robustWriteFile(QUEUE_FILE, JSON.stringify(items, null, 2));
}
var historySink = null;
function setHistorySink(fn) {
  historySink = fn;
}
function pushHistoryItem(item) {
  historySink?.(item);
}
function sendText(text) {
  const item = {
    id: makeId(),
    type: "text",
    content: text,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
  withQueueLock(() => {
    const queue = readQueue();
    queue.push(item);
    writeQueue(queue);
  });
  appendSharedHistory({ id: item.id, kind: "text", text, timestamp: item.timestamp });
  return item;
}
function sendFile(filePath) {
  withQueueLock(() => {
    const queue = readQueue();
    queue.push({
      id: makeId(),
      type: "file",
      path: filePath,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
    writeQueue(queue);
  });
}
function readQuestion() {
  if (!fs.existsSync(QUESTION_FILE)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(QUESTION_FILE, "utf-8"));
    return data && data.id && data.questions ? data : null;
  } catch {
    return null;
  }
}
function writeAnswer(answer) {
  ensureDir();
  fs.writeFileSync(ANSWER_FILE, JSON.stringify(answer, null, 2), "utf-8");
}
function readReply() {
  if (!fs.existsSync(REPLY_FILE)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(REPLY_FILE, "utf-8"));
    return data && data.content ? data : null;
  } catch {
    return null;
  }
}
var AGENTS_SUBDIR = "agents";
function sanitizeAgentId(agentId) {
  if (!agentId || typeof agentId !== "string") {
    return "";
  }
  return agentId.trim().replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
}
function agentDirFor(agentId) {
  const id = sanitizeAgentId(agentId);
  return id ? path.join(dataDir, AGENTS_SUBDIR, id) : dataDir;
}
function forgetAgentDir(agentId) {
  const id = sanitizeAgentId(agentId);
  if (!id) {
    return;
  }
  try {
    fs.rmSync(path.join(dataDir, AGENTS_SUBDIR, id), {
      recursive: true,
      force: true
    });
  } catch {
  }
}
function ensureDirAt(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
function acquireLockIn(lockDir, timeoutMs = 2e3) {
  const start = Date.now();
  for (; ; ) {
    try {
      fs.mkdirSync(lockDir);
      return true;
    } catch {
      try {
        const st = fs.statSync(lockDir);
        if (Date.now() - st.mtimeMs > 5e3) {
          try {
            fs.rmdirSync(lockDir);
          } catch {
          }
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        return false;
      }
      sleepSync(8);
    }
  }
}
function withLockIn(dir, fn) {
  ensureDirAt(dir);
  const lockDir = path.join(dir, "queue.lock");
  const locked = acquireLockIn(lockDir);
  try {
    return fn();
  } finally {
    if (locked) {
      try {
        fs.rmdirSync(lockDir);
      } catch {
      }
    }
  }
}
function readJsonArrayAt(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
function readQueueFor(agentId) {
  const dir = agentDirFor(agentId);
  ensureDirAt(dir);
  return readJsonArrayAt(path.join(dir, "queue.json"));
}
function writeQueueFor(items, agentId) {
  const dir = agentDirFor(agentId);
  ensureDirAt(dir);
  robustWriteFile(path.join(dir, "queue.json"), JSON.stringify(items, null, 2));
}
function getQueueCountFor(agentId) {
  return readQueueFor(agentId).length;
}
function sendTextTo(agentId, text) {
  const item = {
    id: makeId(),
    type: "text",
    content: text,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
  const dir = agentDirFor(agentId);
  withLockIn(dir, () => {
    const queue = readJsonArrayAt(path.join(dir, "queue.json"));
    queue.push(item);
    robustWriteFile(path.join(dir, "queue.json"), JSON.stringify(queue, null, 2));
  });
  appendSharedHistory({ id: item.id, kind: "text", text, timestamp: item.timestamp });
  return item;
}
function sendImageTo(agentId, filePath, caption, dataUrl) {
  const item = {
    id: makeId(),
    type: "image",
    path: filePath,
    caption,
    dataUrl,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
  const dir = agentDirFor(agentId);
  withLockIn(dir, () => {
    const queue = readJsonArrayAt(path.join(dir, "queue.json"));
    queue.push(item);
    robustWriteFile(path.join(dir, "queue.json"), JSON.stringify(queue, null, 2));
  });
  return item;
}
function sendFileTo(agentId, filePath) {
  const dir = agentDirFor(agentId);
  withLockIn(dir, () => {
    const queue = readJsonArrayAt(path.join(dir, "queue.json"));
    queue.push({
      id: makeId(),
      type: "file",
      path: filePath,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
    robustWriteFile(path.join(dir, "queue.json"), JSON.stringify(queue, null, 2));
  });
}
function deleteQueueItemFor(id, agentId) {
  const dir = agentDirFor(agentId);
  withLockIn(dir, () => {
    const queue = readJsonArrayAt(path.join(dir, "queue.json"));
    robustWriteFile(
      path.join(dir, "queue.json"),
      JSON.stringify(queue.filter((it) => it.id !== id), null, 2)
    );
  });
}
function clearQueueFor(agentId) {
  const dir = agentDirFor(agentId);
  withLockIn(dir, () => writeQueueFor([], agentId));
}
function listAgentDirIds() {
  try {
    const base = path.join(dataDir, AGENTS_SUBDIR);
    return fs.readdirSync(base).filter((id) => {
      try {
        return fs.statSync(path.join(base, id)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
function clearAllQueues() {
  clearQueueFor(void 0);
  try {
    const base = path.join(dataDir, AGENTS_SUBDIR);
    for (const id of fs.readdirSync(base)) {
      try {
        if (fs.statSync(path.join(base, id)).isDirectory())
          clearQueueFor(id);
      } catch {
      }
    }
  } catch {
  }
}
function updateQueueItemFor(id, updates, agentId) {
  const dir = agentDirFor(agentId);
  withLockIn(dir, () => {
    const queue = readJsonArrayAt(path.join(dir, "queue.json"));
    const idx = queue.findIndex((it) => it.id === id);
    if (idx === -1) {
      return;
    }
    if (updates.content !== void 0 && queue[idx].type === "text") {
      queue[idx].content = updates.content;
    }
    robustWriteFile(path.join(dir, "queue.json"), JSON.stringify(queue, null, 2));
  });
}
function readReplyFor(agentId) {
  const file = path.join(agentDirFor(agentId), "reply.json");
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return data && data.content ? data : null;
  } catch {
    return null;
  }
}
function clearReplyFor(agentId) {
  try {
    fs.unlinkSync(path.join(agentDirFor(agentId), "reply.json"));
  } catch {
  }
}
function readQuestionFor(agentId) {
  const file = path.join(agentDirFor(agentId), "question.json");
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return data && data.id && data.questions ? data : null;
  } catch {
    return null;
  }
}
function writeAnswerFor(answer, agentId) {
  const dir = agentDirFor(agentId);
  ensureDirAt(dir);
  fs.writeFileSync(path.join(dir, "answer.json"), JSON.stringify(answer, null, 2), "utf-8");
}
function cancelQuestionFor(agentId) {
  const q = readQuestionFor(agentId);
  if (!q) {
    return;
  }
  const answers = q.questions.map((qi, i) => ({
    questionId: qi.id,
    selected: [],
    other: i === 0 ? "User cancelled the answer" : ""
  }));
  writeAnswerFor({ id: q.id, answers }, agentId);
}
function scanAllAgents(maxAgeMs = AGENT_STALE_MS) {
  const root = path.join(dataDir, AGENTS_SUBDIR);
  let ids = [];
  try {
    ids = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const id of ids) {
    const dir = path.join(root, id);
    try {
      if (!fs.statSync(dir).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    let ts = 0;
    let beatState = "idle";
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, "agent-alive.json"), "utf-8"));
      ts = typeof data.ts === "number" ? data.ts : 0;
      beatState = data.state === "working" ? "working" : "waiting";
    } catch {
    }
    const connected = ts > 0 && Date.now() - ts <= maxAgeMs;
    out.push({
      id,
      connected,
      state: connected ? beatState : "idle",
      ts,
      queueCount: getQueueCountFor(id)
    });
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}
function readCardState() {
  ensureDir();
  if (!fs.existsSync(CARD_FILE)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(CARD_FILE, "utf-8"));
    return data && data.code ? data : null;
  } catch {
    return null;
  }
}
function clearCardState() {
  try {
    fs.unlinkSync(CARD_FILE);
  } catch {
  }
}
function apiRequest(_endpoint, _body) {
  return Promise.resolve({ success: false, error: "remote API disabled" });
}
async function activateCard(_code, _machineId) {
  return {
    success: true,
    data: {
      code: "",
      expires_at: "",
      activated_at: (/* @__PURE__ */ new Date()).toISOString(),
      duration_hours: 0
    }
  };
}
function isCardValid() {
  return true;
}
async function pollRemoteMessages(cardCode, workspace2) {
  try {
    const resp = await apiRequest("/mcp-cards/remote-poll", {
      code: cardCode,
      workspace: workspace2 || ""
    });
    if (resp.success && Array.isArray(resp.data)) {
      return resp.data;
    }
    return [];
  } catch {
    return [];
  }
}
async function pushRemoteReply(cardCode, content, workspace2) {
  try {
    const resp = await apiRequest("/mcp-cards/remote-reply", {
      code: cardCode,
      content,
      workspace: workspace2 || null
    });
    return !!resp.success;
  } catch {
    return false;
  }
}
async function sendWorkspaceHeartbeat(cardCode, workspaceName, workspacePath) {
  try {
    await apiRequest("/mcp-cards/workspace-heartbeat", {
      code: cardCode,
      workspace_name: workspaceName,
      workspace_path: workspacePath || null
    });
  } catch {
  }
}
async function pushRemoteQuestion(cardCode, questionId, questions, workspace2) {
  try {
    const resp = await apiRequest("/mcp-cards/remote-question", {
      code: cardCode,
      question_id: questionId,
      questions,
      workspace: workspace2 || null
    });
    return !!resp.success;
  } catch {
    return false;
  }
}
async function cancelRemoteQuestion(cardCode, questionId) {
  try {
    const resp = await apiRequest("/mcp-cards/remote-cancel-question", {
      code: cardCode,
      question_id: questionId || null
    });
    return !!resp.success;
  } catch {
    return false;
  }
}
async function pollRemoteAnswer(cardCode, questionId) {
  try {
    const resp = await apiRequest(
      "/mcp-cards/remote-poll-answer",
      { code: cardCode, question_id: questionId }
    );
    if (resp.success && resp.data) {
      return resp.data;
    }
    return null;
  } catch {
    return null;
  }
}
function getCursorConfigDir() {
  switch (process.platform) {
    case "win32":
      return path.join(
        process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
        "Cursor"
      );
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", "Cursor");
    default:
      return path.join(os.homedir(), ".config", "Cursor");
  }
}
function readVscdbViaSqlite(dbPath) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const tokenRow = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/accessToken");
    const emailRow = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/cachedEmail");
    db.close();
    if (tokenRow?.value) {
      return { token: tokenRow.value, email: emailRow?.value || "" };
    }
  } catch {
  }
  try {
    const { execSync } = require("child_process");
    const escaped = dbPath.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const script = `const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync('${escaped}',{readOnly:true});const t=db.prepare("SELECT value FROM ItemTable WHERE key=?").get("cursorAuth/accessToken");const e=db.prepare("SELECT value FROM ItemTable WHERE key=?").get("cursorAuth/cachedEmail");db.close();console.log(JSON.stringify({t:t?.value||"",e:e?.value||""}))`;
    const out = execSync(`node --disable-warning=ExperimentalWarning -e "${script}"`, {
      encoding: "utf-8",
      timeout: 1e4,
      windowsHide: true
    }).trim();
    const parsed = JSON.parse(out);
    if (parsed.t) {
      return { token: parsed.t, email: parsed.e || "" };
    }
  } catch {
  }
  return null;
}
function readCursorAuth() {
  const gsDir = path.join(getCursorConfigDir(), "User", "globalStorage");
  const dbPath = path.join(gsDir, "state.vscdb");
  if (fs.existsSync(dbPath)) {
    const result = readVscdbViaSqlite(dbPath);
    if (result) {
      return result;
    }
  }
  const jsonPath = path.join(gsDir, "storage.json");
  if (fs.existsSync(jsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      const token = data["cursorAuth/accessToken"];
      if (token) {
        return { token, email: data["cursorAuth/cachedEmail"] || "" };
      }
    } catch {
    }
  }
  const authPath = path.join(gsDir, "cursor.auth.json");
  if (fs.existsSync(authPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      if (data.token) {
        return { token: data.token, email: data.email || "" };
      }
    } catch {
    }
  }
  return null;
}
function readInjectedToken() {
  ensureDir();
  if (!fs.existsSync(INJECTED_TOKEN_FILE)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(INJECTED_TOKEN_FILE, "utf-8"));
    return data && data.token ? data : null;
  } catch {
    return null;
  }
}
function writeInjectedToken(token) {
  ensureDir();
  fs.writeFileSync(INJECTED_TOKEN_FILE, JSON.stringify({ token }, null, 2), "utf-8");
}
function clearInjectedToken() {
  try {
    fs.unlinkSync(INJECTED_TOKEN_FILE);
  } catch {
  }
}
function getEffectiveAuth() {
  const injected = readInjectedToken();
  if (injected) {
    return { token: injected.token, email: "" };
  }
  return readCursorAuth();
}
async function fetchCursorUsage() {
  const auth = getEffectiveAuth();
  if (!auth) {
    return { success: false, error: "Cursor login not detected" };
  }
  return {
    success: true,
    email: auth.email || "",
    membershipType: "local",
    isUnlimited: true,
    usagePct: null,
    planUsed: 0,
    planLimit: void 0,
    onDemandUsed: 0,
    billingCycleStart: "",
    billingCycleEnd: "",
    displayMessage: "",
    totalCost: 0,
    eventsCount: 0,
    models: []
  };
}
function getMcpServerPath() {
  const extDir = path.dirname(path.dirname(__filename));
  return path.join(extDir, "dist", "mcp-server.mjs");
}
function getGlobalMcpJsonPath() {
  return path.join(os.homedir(), ".cursor", "mcp.json");
}
function applyMcpServerEntry(config, messengerDataDir) {
  if (!config.mcpServers) {
    config.mcpServers = {};
  }
  delete config.mcpServers["moyu-message"];
  delete config.mcpServers["jefr cursor"];
  delete config.mcpServers["jefr"];
  const mcpServerConfig = {
    command: "node",
    args: [getMcpServerPath()]
  };
  if (messengerDataDir) {
    mcpServerConfig.env = { MESSENGER_DATA_DIR: messengerDataDir };
  }
  config.mcpServers["jefr"] = mcpServerConfig;
  return config;
}
function setupGlobalMcpConfig(messengerDataDir) {
  const mcpJsonPath = getGlobalMcpJsonPath();
  const cursorDir = path.dirname(mcpJsonPath);
  if (!fs.existsSync(cursorDir)) {
    fs.mkdirSync(cursorDir, { recursive: true });
  }
  const previousContent = fs.existsSync(mcpJsonPath) ? fs.readFileSync(mcpJsonPath, "utf-8") : "";
  let config = {};
  if (fs.existsSync(mcpJsonPath)) {
    try {
      config = JSON.parse(previousContent);
    } catch {
    }
  }
  applyMcpServerEntry(config, messengerDataDir);
  const nextContent = JSON.stringify(config, null, 2);
  if (nextContent !== previousContent) {
    fs.writeFileSync(mcpJsonPath, nextContent, "utf-8");
    return true;
  }
  return false;
}
function setupMcpConfig(workspaceFolder, messengerDataDir) {
  const cursorDir = path.join(workspaceFolder, ".cursor");
  if (!fs.existsSync(cursorDir)) {
    fs.mkdirSync(cursorDir, { recursive: true });
  }
  const mcpJsonPath = path.join(cursorDir, "mcp.json");
  const previousContent = fs.existsSync(mcpJsonPath) ? fs.readFileSync(mcpJsonPath, "utf-8") : "";
  let config = {};
  if (fs.existsSync(mcpJsonPath)) {
    try {
      config = JSON.parse(previousContent);
    } catch {
    }
  }
  if (!config.mcpServers) {
    config.mcpServers = {};
  }
  applyMcpServerEntry(config, messengerDataDir);
  const nextContent = JSON.stringify(config, null, 2);
  let changed = false;
  if (nextContent !== previousContent) {
    fs.writeFileSync(mcpJsonPath, nextContent, "utf-8");
    changed = true;
  }
  if (setupCursorRules(workspaceFolder)) {
    changed = true;
  }
  return changed;
}
function removeMcpConfig(workspaceFolder) {
  const mcpJsonPath = path.join(workspaceFolder, ".cursor", "mcp.json");
  let removed = false;
  if (fs.existsSync(mcpJsonPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
      if (!config.mcpServers) {
        config.mcpServers = {};
      }
      const keys = ["jefr", "jefr cursor", "moyu-message"];
      for (const key of keys) {
        if (config.mcpServers[key]) {
          delete config.mcpServers[key];
          removed = true;
        }
      }
      if (removed) {
        fs.writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2), "utf-8");
      }
    } catch {
    }
  }
  if (removeCursorRules(workspaceFolder)) {
    removed = true;
  }
  return removed;
}
var RULES_CONTENT = `---
description: Automatically call Messenger MCP to check for pending messages
globs: "**/*"
alwaysApply: true
---

# MCP tool usage rules

1. After each conversation turn is **fully output**, the last step must call \`check_messages\`. Applies to Agent/Plan/Debug/Ask modes with no exceptions.
2. \`check_messages\` blocks until the user sends a new message; process it, reply, then call \`check_messages\` again \u2014 perpetual loop: reply \u2192 check_messages \u2192 receive message \u2192 reply \u2192 check_messages.
3. Never call \`check_messages\` at the start of a turn or before the reply is complete. Only exception: the user explicitly asks to end the conversation.
4. After writing a plan (Plan), finishing analysis (Debug), or answering a question (Ask), do not end the turn \u2014 call \`check_messages\` and wait for user feedback.
5. When the user must choose or confirm (pick a plan, framework, approve an action, etc.), call \`ask_question\`. Do not use Cursor's built-in ask_user_question.
6. \`ask_question\` format: \`{ "questions": [{ "question": "Question text", "options": [{ "id": "a", "label": "Option A" }, { "id": "b", "label": "Option B" }], "allow_multiple": false }] }\`
7. Single-select: \`allow_multiple: false\`; multi-select: \`allow_multiple: true\`; one \`questions\` array may mix both.
8. Users may add custom text (Other field) on each question; no extra option needed for that.
9. After \`ask_question\` returns an answer, still call \`check_messages\` to keep listening.
10. Do not use \`ask_question\` at the end of every turn to ask "anything else?"; end turns with \`check_messages\` only. Use \`ask_question\` only when a real decision is needed.
11. \`check_messages\` accepts optional \`reply\` (string, Markdown): summary shown in the plugin modal. Example: \`{ "reply": "## Summary
Changes complete..." }\`
12. Before ending a session, prefer passing \`reply\` with key conclusions; omit \`reply\` if no summary is needed.
13. Do not spawn subagents for parallel tasks.
14. If \`check_messages\` or \`ask_question\` returns early due to client cancel, connection issues, or internal errors, and the user did not ask to end the chat, do not show internal \`[system]\` text to the user \u2014 call the tool again immediately.
15. During multi-step work, after each key step call \`send_progress\` with a summary. Example: \`{ "progress": "## Step 1 complete
Updated xxx file..." }\`. \`send_progress\` returns immediately; continue to the next step.
16. \`progress\` should include: what was done, current approach, next step. Use concise Markdown.

---
**End of turn (mandatory)**: Only after the reply is **fully complete**, the last step must call the jefr MCP \`check_messages\` tool (CallMcpTool, server identifier for jefr, toolName \`check_messages\`, arguments \`{}\`). Never call it at the start of a turn or before the reply is done. Use \`ask_question\` only when the user must make a choice during the task (e.g. pick a framework or plan).`;
function setupCursorRules(workspaceFolder) {
  const rulesDir = path.join(workspaceFolder, ".cursor", "rules");
  if (!fs.existsSync(rulesDir)) {
    fs.mkdirSync(rulesDir, { recursive: true });
  }
  const currentRulesPath = path.join(rulesDir, RULES_FILE_NAME);
  let changed = false;
  const previousRulesContent = fs.existsSync(currentRulesPath) ? fs.readFileSync(currentRulesPath, "utf-8") : "";
  if (previousRulesContent !== RULES_CONTENT) {
    fs.writeFileSync(currentRulesPath, RULES_CONTENT, "utf-8");
    changed = true;
  }
  const legacyRulesPath = path.join(rulesDir, LEGACY_RULES_FILE_NAME);
  if (removeLegacyRulesIfManaged(legacyRulesPath)) {
    changed = true;
  }
  return changed;
}
function removeCursorRules(workspaceFolder) {
  const rulesDir = path.join(workspaceFolder, ".cursor", "rules");
  let removed = false;
  const currentRulesPath = path.join(rulesDir, RULES_FILE_NAME);
  if (fs.existsSync(currentRulesPath)) {
    fs.unlinkSync(currentRulesPath);
    removed = true;
  }
  const legacyRulesPath = path.join(rulesDir, LEGACY_RULES_FILE_NAME);
  if (removeLegacyRulesIfManaged(legacyRulesPath)) {
    removed = true;
  }
  return removed;
}
function removeLegacyRulesIfManaged(filePath) {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    if (content === RULES_CONTENT) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

// src/local-server.ts
var http = __toESM(require("http"));
var crypto = __toESM(require("crypto"));
var fs2 = __toESM(require("fs"));
var os2 = __toESM(require("os"));
var path2 = __toESM(require("path"));
function handlePastedImage(dataUrl, caption, target) {
  const match = /^data:image\/([\w.+-]+);base64,(.+)$/.exec(dataUrl || "");
  if (!match)
    return false;
  try {
    const extRaw = match[1].toLowerCase();
    const ext = extRaw === "jpeg" ? "jpg" : extRaw === "svg+xml" ? "svg" : extRaw;
    const buf = Buffer.from(match[2], "base64");
    const tmpPath = path2.join(os2.tmpdir(), `jefr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`);
    fs2.writeFileSync(tmpPath, buf);
    const tgt = target !== void 0 ? target : targetAgentId();
    const item = sendImageTo(tgt, tmpPath, caption, dataUrl);
    pushHistoryItem({ ...item, dataUrl });
    appendSharedHistory({
      id: item.id,
      kind: "image",
      dataUrl,
      caption,
      name: path2.basename(tmpPath),
      path: tmpPath,
      timestamp: item.timestamp
    });
    return true;
  } catch {
    return false;
  }
}
var WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
var PREFERRED_PORT = 39517;
var MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
var PORT_RETRY_MAX = 6;
var PORT_RETRY_DELAY_MS = 400;
var PORT_FILE = path2.join(os2.homedir(), ".moyu-message", "server.json");
function writePortFile(port) {
  try {
    fs2.mkdirSync(path2.dirname(PORT_FILE), { recursive: true });
    fs2.writeFileSync(
      PORT_FILE,
      JSON.stringify({ port, pid: process.pid, preferred: PREFERRED_PORT, ts: Date.now() }),
      "utf-8"
    );
  } catch {
  }
}
function removePortFile() {
  try {
    fs2.unlinkSync(PORT_FILE);
  } catch {
  }
}
var server = null;
var wsClients = [];
var serverPort = 0;
var pollTimer = null;
var lastPushState = "";
var _workspaceInfo = { name: "", path: "" };
var _selectedAgentId;
function setWorkspaceInfo(name, wsPath) {
  _workspaceInfo = { name, path: wsPath };
}
function setSelectedAgentId(agentId) {
  _selectedAgentId = agentId && agentId.trim() ? agentId.trim() : void 0;
  lastPushState = "";
  broadcastStateNow();
}
function targetAgentId() {
  return _selectedAgentId || readSelectedAgentId();
}
function getServerPort() {
  return serverPort;
}
function getConnectedClients() {
  return wsClients.length;
}
function startLocalServer(port = PREFERRED_PORT, attempt = 0) {
  return new Promise((resolve, reject) => {
    if (server) {
      resolve(serverPort);
      return;
    }
    let settled = false;
    const srv = http.createServer(handleHttp);
    srv.on("upgrade", handleUpgrade);
    srv.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        srv.close();
      } catch {
      }
      if (err && err.code === "EADDRINUSE" && port === PREFERRED_PORT) {
        if (attempt < PORT_RETRY_MAX) {
          setTimeout(
            () => startLocalServer(PREFERRED_PORT, attempt + 1).then(resolve, reject),
            PORT_RETRY_DELAY_MS
          );
        } else {
          console.warn(
            `[jefr] port ${PREFERRED_PORT} is still in use after ${PORT_RETRY_MAX} retries; falling back to an ephemeral port. A fixed-port client must read ${PORT_FILE}.`
          );
          startLocalServer(0, attempt + 1).then(resolve, reject);
        }
      } else {
        reject(err);
      }
    });
    srv.listen(port, "127.0.0.1", () => {
      if (settled) {
        return;
      }
      settled = true;
      server = srv;
      serverPort = srv.address().port;
      writePortFile(serverPort);
      if (serverPort !== PREFERRED_PORT) {
        console.warn(
          `[jefr] local server bound to ${serverPort} (preferred ${PREFERRED_PORT} unavailable). Clients should read the port from ${PORT_FILE}.`
        );
      }
      startPushPolling();
      resolve(serverPort);
    });
  });
}
function stopLocalServer() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  for (const c of wsClients) {
    try {
      c.socket.destroy();
    } catch {
    }
  }
  wsClients = [];
  if (server) {
    server.close();
    server = null;
    serverPort = 0;
  }
  removePortFile();
}
function handleHttp(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getControlPanelHtml());
    return;
  }
  if (req.url === "/api/status" && req.method === "GET") {
    const aid = targetAgentId();
    const q = readQuestionFor(aid);
    const reply = readReplyFor(aid);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        cardActive: true,
        cardCode: null,
        cardExpiresAt: null,
        queueCount: getQueueCountFor(aid),
        queue: readQueueFor(aid),
        hasQuestion: !!q,
        hasReply: !!reply,
        workspace: _workspaceInfo,
        wsClients: wsClients.length,
        agent: getAgentStatusFor(aid),
        selectedAgentId: aid || null,
        port: serverPort
      })
    );
    return;
  }
  if (req.url === "/api/send" && req.method === "POST") {
    let body = "";
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted)
        return;
      body += chunk;
      if (body.length > MAX_MESSAGE_BYTES) {
        aborted = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Payload too large" }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (aborted)
        return;
      try {
        const data = JSON.parse(body);
        if (data.text) {
          const aid = targetAgentId();
          const item = sendTextTo(aid, data.text);
          pushHistoryItem({
            id: item.id,
            type: "text",
            content: data.text,
            timestamp: item.timestamp
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
          broadcastWs({ type: "queueUpdate", count: getQueueCountFor(aid) });
          broadcastStateNow();
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "Missing text field" }));
        }
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Invalid JSON" }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end("Not Found");
}
function handleUpgrade(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash("sha1").update(key + WS_MAGIC).digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r
Upgrade: websocket\r
Connection: Upgrade\r
Sec-WebSocket-Accept: ${accept}\r
\r
`
  );
  const client = { socket, alive: true };
  wsClients.push(client);
  const pushState = buildPushState();
  wsSend(socket, JSON.stringify({ type: "init", ...pushState }));
  let buffer = Buffer.alloc(0);
  let fragOpcode = 0;
  let fragParts = [];
  let fragBytes = 0;
  const resetFrag = () => {
    fragOpcode = 0;
    fragParts = [];
    fragBytes = 0;
  };
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_MESSAGE_BYTES) {
      removeClient(client);
      return;
    }
    while (buffer.length >= 2) {
      const parsed = parseFrame(buffer);
      if (!parsed) {
        break;
      }
      buffer = buffer.subarray(parsed.totalLength);
      if (parsed.opcode === 8) {
        removeClient(client);
        socket.end();
        return;
      }
      if (parsed.opcode === 9) {
        wsSendRaw(socket, buildFrame(parsed.payload, 10));
        continue;
      }
      if (parsed.opcode === 10) {
        client.alive = true;
        continue;
      }
      if (parsed.opcode === 1 || parsed.opcode === 2 || parsed.opcode === 0) {
        if (parsed.opcode !== 0) {
          fragOpcode = parsed.opcode;
          fragParts = [];
          fragBytes = 0;
        }
        fragParts.push(parsed.payload);
        fragBytes += parsed.payload.length;
        if (fragBytes > MAX_MESSAGE_BYTES) {
          resetFrag();
          removeClient(client);
          return;
        }
        if (parsed.fin) {
          const full = Buffer.concat(fragParts);
          const op = fragOpcode;
          resetFrag();
          if (op === 1) {
            handleWsMessage(client, full.toString("utf-8"));
          }
        }
      }
    }
  });
  socket.on("close", () => removeClient(client));
  socket.on("error", () => removeClient(client));
}
var recentCids = /* @__PURE__ */ new Set();
var recentCidOrder = [];
function seenCid(cid) {
  if (typeof cid !== "string" || !cid)
    return false;
  if (recentCids.has(cid))
    return true;
  recentCids.add(cid);
  recentCidOrder.push(cid);
  if (recentCidOrder.length > 500) {
    const old = recentCidOrder.shift();
    if (old)
      recentCids.delete(old);
  }
  return false;
}
function ack(client, cid, ok, extra) {
  if (typeof cid !== "string" || !cid)
    return;
  wsSend(client.socket, JSON.stringify({ type: "ack", cid, ok, ...extra }));
}
function handleWsMessage(client, raw) {
  try {
    const msg = JSON.parse(raw);
    const aid = targetAgentId();
    switch (msg.type) {
      case "send": {
        const target = typeof msg.targetAgentId === "string" && msg.targetAgentId.trim() ? msg.targetAgentId.trim() : aid;
        if (seenCid(msg.cid)) {
          ack(client, msg.cid, true, { duplicate: true });
          break;
        }
        const text = typeof msg.text === "string" ? msg.text.trim() : "";
        const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
        const images = atts.filter(
          (a) => a && a.kind === "image" && typeof a.dataUrl === "string"
        );
        let queued = 0;
        try {
          if (images.length > 0) {
            images.forEach((a, i) => {
              if (handlePastedImage(a.dataUrl, i === 0 ? text : "", target)) {
                queued++;
              }
            });
          } else if (text) {
            const item = sendTextTo(target, text);
            pushHistoryItem({
              id: item.id,
              type: "text",
              content: text,
              timestamp: item.timestamp
            });
            queued++;
          }
          ack(client, msg.cid, true, { queued });
          broadcastWs({ type: "queueUpdate", count: getQueueCountFor(target) });
          broadcastStateNow();
        } catch (e) {
          ack(client, msg.cid, false, { error: String(e), queued });
        }
        break;
      }
      case "sendText":
        if (msg.text) {
          if (!seenCid(msg.cid)) {
            const item = sendTextTo(aid, msg.text);
            pushHistoryItem({
              id: item.id,
              type: "text",
              content: msg.text,
              timestamp: item.timestamp
            });
          }
          if (msg.cid)
            wsSend(client.socket, JSON.stringify({ type: "sendAck", cid: msg.cid }));
          broadcastWs({ type: "queueUpdate", count: getQueueCountFor(aid) });
          broadcastStateNow();
        }
        break;
      case "sendImage":
        if (msg.dataUrl) {
          const fresh = !seenCid(msg.cid);
          if (!fresh || handlePastedImage(msg.dataUrl, msg.caption)) {
            if (msg.cid)
              wsSend(client.socket, JSON.stringify({ type: "sendAck", cid: msg.cid }));
            broadcastWs({ type: "queueUpdate", count: getQueueCountFor(aid) });
            broadcastStateNow();
          }
        }
        break;
      case "submitAnswer":
        if (msg.data) {
          writeAnswerFor(msg.data, aid);
        }
        break;
      case "cancelQuestion":
        cancelQuestionFor(aid);
        break;
      case "ackReply":
        clearReplyFor(aid);
        break;
      case "deleteQueueItem":
        if (msg.id) {
          deleteQueueItemFor(msg.id, aid);
          broadcastWs({ type: "queueUpdate", count: getQueueCountFor(aid) });
          broadcastStateNow();
        }
        break;
      case "clearQueue":
        clearQueueFor(aid);
        broadcastWs({ type: "queueUpdate", count: getQueueCountFor(aid) });
        broadcastStateNow();
        break;
      case "ping":
        wsSend(client.socket, JSON.stringify({ type: "pong" }));
        break;
    }
  } catch {
  }
}
function removeClient(client) {
  const idx = wsClients.indexOf(client);
  if (idx !== -1) {
    wsClients.splice(idx, 1);
  }
  try {
    client.socket.destroy();
  } catch {
  }
}
function broadcastWs(data) {
  const msg = JSON.stringify(data);
  for (const c of wsClients) {
    wsSend(c.socket, msg);
  }
}
function parseFrame(buf) {
  if (buf.length < 2) {
    return null;
  }
  const fin = (buf[0] & 128) !== 0;
  const opcode = buf[0] & 15;
  const masked = (buf[1] & 128) !== 0;
  let payloadLen = buf[1] & 127;
  let offset = 2;
  if (payloadLen === 126) {
    if (buf.length < 4) {
      return null;
    }
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) {
      return null;
    }
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  const totalLength = offset + maskLen + payloadLen;
  if (buf.length < totalLength) {
    return null;
  }
  let payload = buf.subarray(offset + maskLen, offset + maskLen + payloadLen);
  if (masked) {
    const mask = buf.subarray(offset, offset + 4);
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i % 4];
    }
  }
  return { opcode, fin, payload, totalLength };
}
function buildFrame(payload, opcode = 1) {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload;
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 128 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 128 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 128 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}
function wsSend(socket, msg) {
  try {
    wsSendRaw(socket, buildFrame(msg));
  } catch {
  }
}
function wsSendRaw(socket, buf) {
  try {
    socket.write(buf);
  } catch {
  }
}
function buildPushState() {
  const aid = targetAgentId();
  return {
    cardActive: true,
    cardCode: null,
    cardExpiresAt: null,
    queueCount: getQueueCountFor(aid),
    queue: readQueueFor(aid),
    question: readQuestionFor(aid),
    reply: readReplyFor(aid),
    history: readSharedHistory(),
    workspace: _workspaceInfo,
    wsClients: wsClients.length,
    agent: getAgentStatusFor(aid),
    selectedAgentId: aid || null,
    port: serverPort
  };
}
function broadcastStateNow() {
  if (wsClients.length === 0)
    return;
  const state = JSON.stringify(buildPushState());
  lastPushState = state;
  broadcastWs({ type: "stateUpdate", ...JSON.parse(state) });
}
function syncReplyToHistory() {
  try {
    const reply = readReplyFor(targetAgentId());
    if (!reply || !reply.content)
      return;
    appendReplyToSharedHistory(reply);
  } catch {
  }
}
function startPushPolling() {
  if (pollTimer) {
    return;
  }
  pollTimer = setInterval(() => {
    syncReplyToHistory();
    if (wsClients.length === 0) {
      return;
    }
    const state = JSON.stringify(buildPushState());
    if (state !== lastPushState) {
      lastPushState = state;
      broadcastWs({ type: "stateUpdate", ...JSON.parse(state) });
    }
  }, 500);
}
function getControlPanelHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>jefr - Remote Console</title>
<style>
:root{--bg1:#eef1f7;--bg2:#e6eaf3;--surface:#ffffff;--surface-2:#f5f7fb;--fg:#1e2330;--fg2:#5b6473;--fg3:#9aa2b1;--border:#e6e9f1;--border-strong:#d6dbe7;--accent:#6d5cf0;--accent2:#3b82f6;--accent-soft:rgba(109,92,240,0.10);--success:#16a34a;--success-soft:rgba(22,163,74,0.10);--danger:#dc2626;--danger-soft:rgba(220,38,38,0.10);--warn:#d97706;--warn-soft:rgba(217,119,6,0.12);--radius:14px;--radius-sm:10px;--shadow-sm:0 1px 2px rgba(16,24,40,0.06),0 1px 3px rgba(16,24,40,0.04);--shadow-accent:0 8px 24px rgba(109,92,240,0.16);--mono:'JetBrains Mono','SFMono-Regular',Consolas,monospace}
*{margin:0;padding:0;box-sizing:border-box}
html{color-scheme:light}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',sans-serif;background:linear-gradient(180deg,var(--bg1),var(--bg2));background-attachment:fixed;color:var(--fg);min-height:100vh;-webkit-tap-highlight-color:transparent;-webkit-font-smoothing:antialiased}
.wrap{max-width:600px;margin:0 auto;padding:24px 16px 48px}
.hdr{text-align:center;padding:8px 0 22px}
.hdr h1{font-size:26px;font-weight:800;background:linear-gradient(135deg,#6d5cf0,#3b82f6);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px;letter-spacing:-0.6px}
.hdr p{font-size:12px;color:var(--fg2);font-weight:500;letter-spacing:0.3px}
.stat-row{display:flex;gap:10px;margin-bottom:18px}
.stat-card{flex:1;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 10px;text-align:center;box-shadow:var(--shadow-sm)}
.stat-val{font-size:19px;font-weight:800;font-family:var(--mono);margin-bottom:3px;color:var(--fg)}
.stat-val.on{color:var(--success)}.stat-val.off{color:var(--danger)}.stat-val.num{color:var(--accent)}
.stat-label{font-size:10px;color:var(--fg2);font-weight:600;text-transform:uppercase;letter-spacing:0.5px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:14px;overflow:hidden;box-shadow:var(--shadow-sm)}
.card.highlight{border-color:rgba(109,92,240,0.40);box-shadow:var(--shadow-accent)}
.card.warn-hl{border-color:rgba(217,119,6,0.40);box-shadow:0 8px 24px rgba(217,119,6,0.14)}
.card-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border)}
.card-title{font-size:13px;font-weight:700;color:var(--fg);letter-spacing:-0.1px}
.card-badge{font-size:10px;padding:3px 11px;border-radius:20px;font-weight:700;letter-spacing:0.2px}
.card-badge.on{background:var(--success-soft);color:var(--success)}
.card-badge.off{background:var(--surface-2);color:var(--fg3)}
.card-badge.accent{background:var(--accent-soft);color:var(--accent)}
.card-body{padding:16px}
.compose-area{display:flex;flex-direction:column;gap:12px}
.compose-input{width:100%;min-height:84px;max-height:200px;padding:12px 14px;background:var(--surface-2);border:1px solid var(--border-strong);border-radius:var(--radius-sm);color:var(--fg);font-size:14px;font-family:inherit;resize:vertical;outline:none;transition:border-color .2s,box-shadow .2s;line-height:1.55}
.compose-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.compose-input::placeholder{color:var(--fg3)}
.compose-area.drop-hl .compose-input{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.thumbs{display:flex;flex-wrap:wrap;gap:8px}
.thumbs:empty{display:none}
.thumb-chip{position:relative;width:56px;height:56px;border-radius:8px;overflow:hidden;border:1px solid var(--border-strong);background:var(--surface-2)}
.thumb-chip img{width:100%;height:100%;object-fit:cover;display:block}
.thumb-rm{position:absolute;top:2px;right:2px;width:18px;height:18px;padding:0;border:none;border-radius:50%;background:rgba(0,0,0,0.6);color:#fff;font-size:13px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center}
.thumb-rm:hover{background:rgba(0,0,0,0.8)}
.compose-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.compose-hint{font-size:11px;color:var(--fg3)}
.btn{padding:10px 24px;border:none;border-radius:var(--radius-sm);font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .15s;white-space:nowrap;-webkit-appearance:none}
.btn-send{background:linear-gradient(135deg,#6d5cf0,#4f46e5);color:#fff;box-shadow:var(--shadow-accent);min-width:84px}
.btn-send:hover{filter:brightness(1.06)}
.btn-send:active{transform:scale(0.97)}
.btn-send:disabled{opacity:1;cursor:not-allowed;transform:none;box-shadow:none;background:var(--border-strong);color:var(--fg3)}
.btn-outline{background:var(--surface);border:1px solid var(--border-strong);color:var(--fg2);padding:8px 16px;font-size:12px}
.btn-outline:hover{background:var(--surface-2);color:var(--fg)}
.btn-warn{background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;box-shadow:0 2px 10px rgba(217,119,6,0.25)}
.btn-danger{background:var(--danger-soft);color:var(--danger);border:1px solid rgba(220,38,38,0.25)}
.btn-danger:hover{background:rgba(220,38,38,0.16)}
.btn-sm{padding:7px 14px;font-size:11px;border-radius:8px}
.sent-ok{color:var(--success);font-size:12px;font-weight:700;animation:fadeIn .3s}
@keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
.q-block{margin-bottom:16px}
.q-text{font-size:14px;font-weight:600;margin-bottom:10px;line-height:1.5;color:var(--fg)}
.q-options{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}
.q-opt{display:flex;align-items:center;gap:10px;padding:11px 14px;background:var(--surface-2);border:1px solid var(--border-strong);border-radius:var(--radius-sm);cursor:pointer;transition:all .15s;font-size:13px;color:var(--fg);-webkit-tap-highlight-color:transparent}
.q-opt:hover{background:var(--accent-soft);border-color:rgba(109,92,240,0.35)}
.q-opt.selected{border-color:var(--accent);background:var(--accent-soft)}
.q-opt .check{width:18px;height:18px;border:2px solid var(--border-strong);border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all .15s}
.q-opt.multi .check{border-radius:5px}
.q-opt.selected .check{border-color:var(--accent);background:var(--accent)}
.q-opt.selected .check::after{content:'';display:block;width:8px;height:8px;background:#fff;border-radius:50%}
.q-opt.selected.multi .check::after{border-radius:1px;width:10px;height:6px;background:transparent;border-bottom:2px solid #fff;border-left:2px solid #fff;transform:rotate(-45deg);margin-top:-2px}
.q-other{width:100%;padding:10px 12px;background:var(--surface-2);border:1px solid var(--border-strong);border-radius:8px;color:var(--fg);font-size:13px;outline:none;font-family:inherit}
.q-other:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.q-other::placeholder{color:var(--fg3)}
.q-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
.reply-content{font-size:13px;line-height:1.7;color:var(--fg);white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto;padding:4px 0}
.reply-actions{display:flex;justify-content:flex-end;margin-top:12px}
.info-row{display:flex;align-items:center;justify-content:space-between;padding:9px 0;font-size:12px;border-bottom:1px solid var(--border)}
.info-row:last-child{border-bottom:none}
.info-k{color:var(--fg2);font-size:11px;font-weight:500}
.info-v{color:var(--fg);font-weight:600;font-family:var(--mono);font-size:11px;text-align:right;max-width:65%;word-break:break-all}
.info-v.accent{color:var(--accent)}
.queue-item{padding:10px 14px;font-size:11px;color:var(--fg2);border-bottom:1px solid var(--border);white-space:pre-wrap;word-break:break-all;line-height:1.45;display:flex;align-items:flex-start;gap:8px}
.queue-item:last-child{border-bottom:none}
.qi-type{font-size:9px;font-weight:800;padding:3px 8px;border-radius:8px;flex-shrink:0;text-transform:uppercase;letter-spacing:0.3px}
.qi-type.text{background:rgba(59,130,246,0.12);color:#2563eb}
.qi-type.image{background:rgba(16,185,129,0.12);color:#059669}
.qi-type.file{background:rgba(217,119,6,0.14);color:#b45309}
.qi-content{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--fg)}
.qi-time{font-size:9px;color:var(--fg3);flex-shrink:0;font-family:var(--mono)}
.empty{text-align:center;padding:24px;color:var(--fg3);font-size:12px}
.msgs{max-height:320px;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.msg-row{display:flex;flex-direction:column;align-items:flex-end;margin-left:auto;max-width:88%}
.msg-row.msg-ai{align-items:flex-start;margin-left:0;margin-right:auto}
.msg-text{background:linear-gradient(135deg,#6d5cf0,#4f46e5);color:#fff;padding:8px 12px;border-radius:14px;border-bottom-right-radius:4px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.msg-reply{background:var(--surface-2);color:var(--fg);border:1px solid var(--border);padding:8px 12px;border-radius:14px;border-bottom-left-radius:4px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.msg-img{max-width:100%;max-height:220px;border-radius:12px;display:block}
.msg-cap{background:linear-gradient(135deg,#6d5cf0,#4f46e5);color:#fff;padding:6px 11px;border-radius:12px;border-bottom-right-radius:4px;font-size:12px;margin-top:4px}
.log-list{max-height:150px;overflow-y:auto;padding:12px 14px;background:var(--surface-2)}
.log-item{font-size:10px;color:var(--fg2);font-family:var(--mono);padding:2px 0;display:flex;gap:8px}
.log-time{color:var(--fg3);flex-shrink:0}
.hidden{display:none!important}
.section-toggle{cursor:pointer;user-select:none;-webkit-user-select:none}
.section-toggle .chevron{transition:transform .2s;display:inline-block;font-size:16px;color:var(--fg3)}
.section-toggle .chevron.open{transform:rotate(90deg)}
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border-strong);border-radius:6px}::-webkit-scrollbar-thumb:hover{background:var(--fg3)}
</style>
</head>
<body>
<div class="wrap">
	<div class="hdr"><h1>jefr</h1><p>Remote Console</p></div>

	<div class="stat-row">
		<div class="stat-card"><div id="statConn" class="stat-val off">-</div><div class="stat-label">Connection</div></div>
		<div class="stat-card"><div id="statAgent" class="stat-val off">-</div><div class="stat-label">Agent</div></div>
		<div class="stat-card"><div id="statQueue" class="stat-val num">0</div><div class="stat-label">Queue</div></div>
		<div class="stat-card"><div id="statWs" class="stat-val num">0</div><div class="stat-label">Clients</div></div>
	</div>

	<!-- Send message -->
	<div class="card highlight">
		<div class="card-head"><span class="card-title">Send message</span><span id="sendStatus"></span></div>
		<div class="card-body">
			<div class="compose-area">
				<div id="thumbs" class="thumbs"></div>
				<textarea id="msgInput" class="compose-input" placeholder="Type a message, or paste / drop an image..." rows="3"></textarea>
				<div class="compose-row">
					<span class="compose-hint">Ctrl+Enter to send &middot; paste an image</span>
					<button id="sendBtn" class="btn btn-send" disabled>Send</button>
				</div>
			</div>
		</div>
	</div>

	<!-- AI question (dynamic) -->
	<div id="questionCard" class="card warn-hl hidden">
		<div class="card-head"><span class="card-title">AI question</span><span class="card-badge accent">Awaiting answer</span></div>
		<div id="questionBody" class="card-body"></div>
	</div>

	<!-- AI reply (dynamic) -->
	<div id="replyCard" class="card hidden">
		<div class="card-head"><span class="card-title">AI reply summary</span></div>
		<div class="card-body">
			<div id="replyContent" class="reply-content"></div>
			<div class="reply-actions"><button id="replyAck" class="btn btn-outline btn-sm">Dismiss</button></div>
		</div>
	</div>

	<!-- Conversation (shared history) -->
	<div class="card">
		<div class="card-head"><span class="card-title">Conversation</span></div>
		<div id="msgs" class="msgs"><div class="empty">No messages yet</div></div>
	</div>

	<!-- Workspace -->
	<div class="card">
		<div class="card-head section-toggle" onclick="toggleSection('wsBody',this)">
			<span class="card-title">Workspace</span>
			<span class="chevron open">\u203A</span>
		</div>
		<div id="wsBody" class="card-body">
			<div class="info-row"><span class="info-k">Project</span><span id="wsName" class="info-v">-</span></div>
			<div class="info-row"><span class="info-k">Path</span><span id="wsPath" class="info-v">-</span></div>
			<div class="info-row"><span class="info-k">License key</span><span id="wsCard" class="info-v">-</span></div>
			<div class="info-row"><span class="info-k">Expires</span><span id="wsExpire" class="info-v">-</span></div>
		</div>
	</div>

	<!-- Queue -->
	<div class="card">
		<div class="card-head"><span class="card-title">Message queue</span><span id="queueBadge" class="card-badge off">0 items</span></div>
		<div id="queueList"><div class="empty">Queue is empty</div></div>
	</div>

	<!-- Log -->
	<div class="card">
		<div class="card-head section-toggle" onclick="toggleSection('logList',this)">
			<span class="card-title">Activity log</span>
			<span class="chevron open">\u203A</span>
		</div>
		<div id="logList" class="log-list"></div>
	</div>
</div>
<script>
(function(){
var ws,reconnT,curQuestion=null,selectedAnswers={},reconnDelay=1000,maxReconnDelay=30000,reconnAttempts=0;
var $=function(id){return document.getElementById(id)};
var esc=function(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')};
function fmtTime(){var d=new Date();return [d.getHours(),d.getMinutes(),d.getSeconds()].map(function(v){return String(v).padStart(2,'0')}).join(':')}
function log(m){var el=document.createElement('div');el.className='log-item';el.innerHTML='<span class="log-time">'+fmtTime()+'</span><span>'+esc(m)+'</span>';var L=$('logList');L.appendChild(el);L.scrollTop=L.scrollHeight;if(L.children.length>60)L.removeChild(L.firstChild)}

window.toggleSection=function(id,el){
	var body=$(id);if(!body)return;
	var hidden=body.style.display==='none';
	body.style.display=hidden?'':'none';
	var chev=el.querySelector('.chevron');
	if(chev){chev.className=hidden?'chevron open':'chevron'}
};

// Send message
var input=$('msgInput'),sendBtn=$('sendBtn'),sendStatus=$('sendStatus'),thumbs=$('thumbs');
var pendingImages=[];
function canSend(){return (!!input.value.trim()||pendingImages.length>0)&&ws&&ws.readyState===1}
function updateSendBtn(){sendBtn.disabled=!canSend()}
function renderThumbs(){
	if(!thumbs)return;
	thumbs.innerHTML='';
	for(var i=0;i<pendingImages.length;i++){
		(function(img){
			var chip=document.createElement('div');chip.className='thumb-chip';
			var im=document.createElement('img');im.src=img.dataUrl;chip.appendChild(im);
			var rm=document.createElement('button');rm.className='thumb-rm';rm.textContent='\\u00D7';
			rm.onclick=function(){pendingImages=pendingImages.filter(function(x){return x.id!==img.id});renderThumbs();updateSendBtn()};
			chip.appendChild(rm);thumbs.appendChild(chip);
		})(pendingImages[i]);
	}
}
function stageImage(dataUrl){
	if(!dataUrl)return;
	pendingImages.push({id:Date.now()+'-'+Math.random().toString(36).slice(2,7),dataUrl:dataUrl});
	renderThumbs();updateSendBtn();
}
function ingestFiles(files){
	for(var i=0;i<files.length;i++){
		var f=files[i];
		if(f.type&&f.type.indexOf('image/')===0){
			(function(){var r=new FileReader();r.onload=function(ev){stageImage(String(ev.target.result||''))};r.readAsDataURL(f)})();
		}
	}
}
input.addEventListener('input',updateSendBtn);
input.addEventListener('keydown',function(e){if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();doSend()}});
input.addEventListener('paste',function(e){
	var dt=e.clipboardData;if(!dt)return;
	var files=[];
	if(dt.files&&dt.files.length){for(var i=0;i<dt.files.length;i++)files.push(dt.files[i]);}
	else if(dt.items){for(var j=0;j<dt.items.length;j++){var it=dt.items[j];if(it.kind==='file'){var f=it.getAsFile();if(f)files.push(f);}}}
	var imgs=files.filter(function(f){return f.type&&f.type.indexOf('image/')===0});
	if(imgs.length){e.preventDefault();ingestFiles(imgs);}
});
var dropZone=input.parentNode;
dropZone.addEventListener('dragover',function(e){e.preventDefault();dropZone.classList.add('drop-hl')});
dropZone.addEventListener('dragleave',function(){dropZone.classList.remove('drop-hl')});
dropZone.addEventListener('drop',function(e){e.preventDefault();dropZone.classList.remove('drop-hl');var files=e.dataTransfer&&e.dataTransfer.files;if(files&&files.length)ingestFiles(Array.prototype.slice.call(files));});
sendBtn.addEventListener('click',doSend);
function doSend(){
	if(!canSend())return;
	var txt=input.value.trim();
	var atts=pendingImages.map(function(im){return {kind:'image',dataUrl:im.dataUrl}});
	var cid='c'+Date.now()+'-'+Math.random().toString(36).slice(2,7);
	// One composite message (text + image[s]) instead of separate sends.
	ws.send(JSON.stringify({type:'send',cid:cid,text:txt,attachments:atts}));
	log('Send: '+(txt?txt.substring(0,40):'')+(atts.length?' [+'+atts.length+' image]':''));
	input.value='';pendingImages=[];renderThumbs();updateSendBtn();
	sendStatus.innerHTML='<span class="sent-ok">Sent</span>';
	setTimeout(function(){sendStatus.innerHTML=''},2000);
	input.focus();
}

// Render AI question
function renderQuestion(q){
	curQuestion=q;selectedAnswers={};
	var card=$('questionCard'),body=$('questionBody');
	if(!q||!q.questions||!q.questions.length){card.classList.add('hidden');return}
	card.classList.remove('hidden');
	var h='';
	for(var i=0;i<q.questions.length;i++){
		var qi=q.questions[i];
		selectedAnswers[qi.id]=[];
		h+='<div class="q-block" data-qid="'+esc(qi.id)+'">';
		h+='<div class="q-text">'+esc(qi.question)+'</div>';
		h+='<div class="q-options">';
		for(var j=0;j<qi.options.length;j++){
			var opt=qi.options[j];
			h+='<div class="q-opt'+(qi.allow_multiple?' multi':'')+'" data-qid="'+esc(qi.id)+'" data-oid="'+esc(opt.id)+'" onclick="toggleOpt(this)">';
			h+='<span class="check"></span><span>'+esc(opt.label)+'</span></div>';
		}
		h+='</div>';
		h+='<input class="q-other" data-qid="'+esc(qi.id)+'" placeholder="Additional notes (optional)">';
		h+='</div>';
	}
	h+='<div class="q-actions"><button class="btn btn-danger btn-sm" onclick="cancelQ()">Cancel</button><button class="btn btn-warn btn-sm" onclick="submitQ()">Submit answer</button></div>';
	body.innerHTML=h;
	card.scrollIntoView({behavior:'smooth',block:'nearest'});
}

window.toggleOpt=function(el){
	var qid=el.getAttribute('data-qid'),oid=el.getAttribute('data-oid');
	if(!curQuestion)return;
	var qi=curQuestion.questions.find(function(q){return q.id===qid});
	if(!qi)return;
	var arr=selectedAnswers[qid]||[];
	var idx=arr.indexOf(oid);
	if(qi.allow_multiple){
		if(idx>-1)arr.splice(idx,1);else arr.push(oid);
	}else{
		arr=idx>-1?[]:[oid];
		var opts=el.parentNode.querySelectorAll('.q-opt');
		for(var k=0;k<opts.length;k++)opts[k].classList.remove('selected');
	}
	selectedAnswers[qid]=arr;
	el.classList.toggle('selected',arr.indexOf(oid)>-1);
};

window.submitQ=function(){
	if(!curQuestion||!ws||ws.readyState!==1)return;
	var answers=[];
	for(var i=0;i<curQuestion.questions.length;i++){
		var qi=curQuestion.questions[i];
		var otherInput=document.querySelector('.q-other[data-qid="'+qi.id+'"]');
		answers.push({questionId:qi.id,selected:selectedAnswers[qi.id]||[],other:otherInput?otherInput.value.trim():''});
	}
	ws.send(JSON.stringify({type:'submitAnswer',data:{id:curQuestion.id,answers:answers}}));
	$('questionCard').classList.add('hidden');
	curQuestion=null;
	log('Answer submitted');
};

window.cancelQ=function(){
	if(!ws||ws.readyState!==1)return;
	ws.send(JSON.stringify({type:'cancelQuestion'}));
	$('questionCard').classList.add('hidden');
	curQuestion=null;
	log('Answer cancelled');
};

// Render AI reply
function renderReply(reply){
	var card=$('replyCard'),content=$('replyContent');
	if(!reply||!reply.content){card.classList.add('hidden');return}
	card.classList.remove('hidden');
	content.textContent=reply.content;
	card.scrollIntoView({behavior:'smooth',block:'nearest'});
}
$('replyAck').addEventListener('click',function(){
	if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:'ackReply'}));
	$('replyCard').classList.add('hidden');
	log('Reply acknowledged');
});

// Render queue
function renderQueue(items){
	var L=$('queueList');
	if(!items||!items.length){L.innerHTML='<div class="empty">Queue is empty</div>';$('queueBadge').textContent='0 items';$('queueBadge').className='card-badge off';return}
	$('queueBadge').textContent=items.length+' items';$('queueBadge').className='card-badge on';
	var h='';
	for(var i=0;i<items.length;i++){
		var it=items[i],tp=it.type||'text';
		var time=it.timestamp?new Date(it.timestamp).toLocaleTimeString():'';
		var contentHtml;
		if(tp==='image'){
			contentHtml=(it.dataUrl?'<img src="'+it.dataUrl+'" style="max-width:120px;max-height:90px;border-radius:6px;display:block;margin-bottom:4px">':'')+(it.caption?'<div>'+esc(it.caption)+'</div>':(it.dataUrl?'':'[Image]'));
		}else if(tp==='file'){
			contentHtml=esc('[File] '+((it.path||'').split(/[\\/\\\\]/).pop()||''));
		}else{
			contentHtml=esc((it.content||'').substring(0,120));
		}
		h+='<div class="queue-item"><span class="qi-type '+tp+'">'+({text:'Text',image:'Image',file:'File'}[tp]||tp)+'</span><span class="qi-content">'+contentHtml+'</span><span class="qi-time">'+time+'</span></div>';
	}
	L.innerHTML=h;
}

var msgIds={};
function renderMessages(history){
	if(!history)return;
	var M=$('msgs');if(!M)return;
	if(history.length&&M.querySelector('.empty'))M.innerHTML='';
	for(var i=0;i<history.length;i++){
		var it=history[i];if(!it||!it.id||msgIds[it.id])continue;msgIds[it.id]=1;
		var row=document.createElement('div');row.className='msg-row'+(it.kind==='reply'?' msg-ai':'');
		if(it.kind==='image'&&it.dataUrl){
			var im=document.createElement('img');im.className='msg-img';im.src=it.dataUrl;row.appendChild(im);
			if(it.caption){var c=document.createElement('div');c.className='msg-cap';c.textContent=it.caption;row.appendChild(c);}
		}else{
			var t=document.createElement('div');t.className=it.kind==='reply'?'msg-reply':'msg-text';t.textContent=it.kind==='file'?('[File] '+(it.name||'')):(it.caption||it.text||'');row.appendChild(t);
		}
		M.appendChild(row);
	}
	M.scrollTop=M.scrollHeight;
}
function updateDashboard(d){
	$('statConn').textContent=d.cardActive?'Online':'Offline';$('statConn').className='stat-val '+(d.cardActive?'on':'off');
	var ag=d.agent||{alive:false,state:'idle'};
	var agText=ag.alive?(ag.state==='working'?'Busy':'Listening'):'None';
	$('statAgent').textContent=agText;
	$('statAgent').className='stat-val '+(ag.alive?(ag.state==='working'?'num':'on'):'off');
	$('statQueue').textContent=d.queueCount||0;
	$('statWs').textContent=d.wsClients||0;
	if(d.workspace){$('wsName').textContent=d.workspace.name||'-';$('wsPath').textContent=d.workspace.path||'-'}
	$('wsCard').textContent=d.cardCode||'-';
	$('wsExpire').textContent=d.cardExpiresAt?new Date(d.cardExpiresAt).toLocaleString():'-';
	renderQueue(d.queue||[]);
	renderMessages(d.history||[]);
	if(d.question)renderQuestion(d.question);
	if(d.reply)renderReply(d.reply);
}

function connect(){
	if(ws)return;ws=new WebSocket('ws://'+location.host);
	ws.onopen=function(){reconnDelay=1000;reconnAttempts=0;log('Connected');updateSendBtn();$('statConn').textContent='Online';$('statConn').className='stat-val on'};
	ws.onclose=function(){ws=null;updateSendBtn();reconnAttempts++;var delay=Math.min(reconnDelay*Math.pow(1.5,reconnAttempts-1),maxReconnDelay);var sec=Math.round(delay/1000);if(reconnAttempts<=3){log('Disconnected, reconnecting in '+sec+'s')}else if(reconnAttempts%5===0){log('Still reconnecting... (attempt '+reconnAttempts+')')};$('statConn').textContent='Offline';$('statConn').className='stat-val off';reconnT=setTimeout(connect,delay)};
	ws.onerror=function(){if(reconnAttempts<=2)log('Connection error')};
	ws.onmessage=function(e){
		try{
			var m=JSON.parse(e.data);
			if(m.type==='init'||m.type==='stateUpdate'){updateDashboard(m);updateSendBtn()}
			else if(m.type==='queueUpdate'){$('statQueue').textContent=m.count||0}
			else if(m.type==='ack'){if(!m.ok)log('Send failed: '+(m.error||'unknown'))}
			else if(m.type==='pong'){}
		}catch(err){log('Parse error')}
	};
}

fetch('/api/status').then(function(r){return r.json()}).then(updateDashboard).catch(function(){});
connect();
})();
</script>
</body>
</html>`;
}

// src/agentStats.ts
function newStat() {
  return {
    connectCount: 0,
    reconnectCount: 0,
    reconnectsSinceConnect: 0,
    connected: false,
    connectedSince: 0,
    lastSeen: 0,
    lastReconnectAt: 0
  };
}
function reconcile(roster, stats, now, opts) {
  const views = [];
  const dropped = [];
  const prune = [];
  for (const r of roster) {
    let s = stats.get(r.id);
    if (!s) {
      s = newStat();
      stats.set(r.id, s);
    }
    if (r.connected) {
      if (!s.connected) {
        s.connected = true;
        s.connectCount++;
        s.connectedSince = now;
        s.reconnectsSinceConnect = 0;
      }
      s.lastSeen = now;
    } else if (s.connected) {
      s.connected = false;
      s.connectedSince = 0;
    }
    const lastAlive = r.ts > 0 ? Math.max(r.ts, s.lastSeen) : s.lastSeen;
    if (!r.connected && (lastAlive === 0 || now - lastAlive > opts.forgetMs)) {
      prune.push(r.id);
      continue;
    }
    views.push({
      id: r.id,
      connected: r.connected,
      state: r.state,
      queueCount: r.queueCount,
      connectCount: s.connectCount,
      reconnectCount: s.reconnectCount,
      connectedSince: r.connected ? s.connectedSince : 0
    });
    if (!r.connected && s.connectCount > 0 && s.reconnectsSinceConnect < opts.maxReconnects) {
      dropped.push(r.id);
    }
  }
  return { views, dropped, prune };
}
function pickReconnect(dropped, stats, now, debounceMs) {
  for (const id of dropped) {
    const s = stats.get(id);
    if (!s)
      continue;
    if (s.lastReconnectAt === 0 || now - s.lastReconnectAt >= debounceMs) {
      return id;
    }
  }
  return null;
}

// src/cdp-monitor.ts
var http2 = __toESM(require("http"));

// node_modules/ws/wrapper.mjs
var import_stream = __toESM(require_stream(), 1);
var import_extension = __toESM(require_extension(), 1);
var import_permessage_deflate = __toESM(require_permessage_deflate(), 1);
var import_receiver = __toESM(require_receiver(), 1);
var import_sender = __toESM(require_sender(), 1);
var import_subprotocol = __toESM(require_subprotocol(), 1);
var import_websocket = __toESM(require_websocket(), 1);
var import_websocket_server = __toESM(require_websocket_server(), 1);
var wrapper_default = import_websocket.default;

// src/cdp-monitor.ts
var import_events = require("events");
var CDP_HOST = "127.0.0.1";
var CDP_PORT = 9222;
var POLL_INTERVAL_MS = 500;
var CdpSession = class {
  ws = null;
  messageId = 0;
  pending = /* @__PURE__ */ new Map();
  async connect(wsUrl) {
    return new Promise((resolve, reject) => {
      this.ws = new wrapper_default(wsUrl, { handshakeTimeout: 5e3 });
      this.ws.on("open", () => {
        this.call("Runtime.enable").then(() => resolve()).catch(reject);
      });
      this.ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (typeof msg.id === "number" && this.pending.has(msg.id)) {
            const { resolve: resolve2 } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            resolve2(msg);
          }
        } catch {
        }
      });
      this.ws.on("error", reject);
      this.ws.on("close", () => {
        for (const { reject: reject2 } of this.pending.values()) {
          reject2(new Error("WebSocket closed"));
        }
        this.pending.clear();
      });
    });
  }
  async call(method, params) {
    if (!this.ws || this.ws.readyState !== wrapper_default.OPEN) {
      throw new Error("WebSocket not connected");
    }
    const id = ++this.messageId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("CDP call timeout"));
        }
      }, 1e4);
    });
  }
  async evaluate(expression, awaitPromise = true) {
    const resp = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true
    });
    if (resp.exceptionDetails) {
      throw new Error(`JS exception: ${JSON.stringify(resp.exceptionDetails)}`);
    }
    return resp.result?.result?.value;
  }
  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
      }
      this.ws = null;
    }
  }
};
var CdpMonitor = class extends import_events.EventEmitter {
  session = null;
  wsUrl = null;
  pageTitle = null;
  pollTimer = null;
  lastStatus = null;
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  /** Poll an evaluate expression until it returns truthy or the timeout elapses.
   *  Returns as soon as the UI settles, so it's far faster than a fixed sleep
   *  while still bounding the worst case. */
  async pollEval(expr, timeoutMs, stepMs = 50) {
    const start = Date.now();
    for (; ; ) {
      let v;
      try {
        v = await this.session.evaluate(expr, false);
      } catch {
        v = void 0;
      }
      if (v)
        return v;
      if (Date.now() - start >= timeoutMs)
        return v;
      await this.sleep(stepMs);
    }
  }
  async clickAt(x, y) {
    if (!this.session) {
      throw new Error("CDP session not connected");
    }
    await this.session.call("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y
    });
    await this.session.call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    await this.session.call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1
    });
  }
  /** Start monitoring. Emits 'status' events with CdpStatus on each poll. */
  async start() {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    await this.poll();
  }
  /** Stop monitoring and disconnect. */
  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.session) {
      this.session.close();
      this.session = null;
    }
    this.wsUrl = null;
    this.pageTitle = null;
  }
  /** Get current status (cached from last poll). */
  getStatus() {
    return this.lastStatus || {
      connected: false,
      pageTitle: null,
      tiles: [],
      error: "Not started"
    };
  }
  /** Force an immediate poll (useful after actions). */
  async pollNow() {
    return this.poll();
  }
  async connect() {
    try {
      const targets = await this.fetchTargets();
      const workbench = await this.findWorkbench(targets);
      if (!workbench) {
        throw new Error("No workbench page found (is Cursor running with --remote-debugging-port=9222?)");
      }
      this.wsUrl = workbench.webSocketDebuggerUrl;
      this.pageTitle = workbench.title;
      this.session = new CdpSession();
      await this.session.connect(this.wsUrl);
    } catch (e) {
      this.emitStatus({
        connected: false,
        pageTitle: null,
        tiles: [],
        error: e.message
      });
      throw e;
    }
  }
  async fetchTargets() {
    return new Promise((resolve, reject) => {
      const req = http2.get(`http://${CDP_HOST}:${CDP_PORT}/json/list`, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error("Invalid CDP response"));
          }
        });
      });
      req.on("error", reject);
      req.setTimeout(5e3, () => {
        req.destroy();
        reject(new Error("CDP connection timeout"));
      });
    });
  }
  async findWorkbench(targets) {
    const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
    const agentsPage = pages.find((p) => /Cursor Agents/i.test(p.title || ""));
    if (agentsPage) {
      const hasEditor = await this.checkHasEditor(agentsPage.webSocketDebuggerUrl);
      if (hasEditor) {
        return { webSocketDebuggerUrl: agentsPage.webSocketDebuggerUrl, title: agentsPage.title || "" };
      }
    }
    for (const page of pages) {
      const hasEditor = await this.checkHasEditor(page.webSocketDebuggerUrl);
      if (hasEditor) {
        return { webSocketDebuggerUrl: page.webSocketDebuggerUrl, title: page.title || "" };
      }
    }
    return null;
  }
  async checkHasEditor(wsUrl) {
    const session = new CdpSession();
    try {
      await session.connect(wsUrl);
      const result = await session.evaluate("!!document.querySelector('.tiptap.ProseMirror')", false);
      return !!result;
    } catch {
      return false;
    } finally {
      session.close();
    }
  }
  async poll() {
    if (!this.session) {
      try {
        await this.connect();
      } catch (e) {
        const status = {
          connected: false,
          pageTitle: null,
          tiles: [],
          error: e.message
        };
        this.emitStatus(status);
        return status;
      }
    }
    try {
      const tiles = await this.queryTileState();
      const status = {
        connected: true,
        pageTitle: this.pageTitle,
        tiles,
        error: null
      };
      this.emitStatus(status);
      return status;
    } catch (e) {
      this.session?.close();
      this.session = null;
      const status = {
        connected: false,
        pageTitle: null,
        tiles: [],
        error: e.message
      };
      this.emitStatus(status);
      return status;
    }
  }
  /** Focus the composer of the tile whose agentId matches. Returns true on success. */
  async focusAgent(agentId) {
    if (!this.session)
      return false;
    const js = `
(function() {
  const TARGET = ${JSON.stringify(agentId)};
  function tileRoots() {
    const tiled = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
    if (tiled.length > 0) return tiled;
    const shell = document.querySelector('.agent-panel-conversation-shell');
    return shell ? [shell] : [];
  }
  function agentIdOf(node) {
    const k = Object.keys(node).find(x =>
      x.startsWith('__reactFiber$') || x.startsWith('__reactInternalInstance$')
    );
    let f = k ? node[k] : null, steps = 0;
    while (f && steps++ < 40) {
      const p = f.memoizedProps;
      if (p && typeof p === 'object' && typeof p.agentId === 'string') return p.agentId;
      f = f.return;
    }
    return null;
  }
  const roots = tileRoots();
  for (let i = 0; i < roots.length; i++) {
    const t = roots[i];
    if (agentIdOf(t) !== TARGET) continue;
    const eds = [...t.querySelectorAll('.tiptap.ProseMirror.ui-prompt-input-editor__input')]
      .filter(e => !e.closest('.prompt-edit-input'));
    const isFu = e => e.closest('.agent-panel-followup-input') ||
      /send follow-?up/i.test((e.querySelector('[data-placeholder]')?.getAttribute('data-placeholder')) ||
        e.getAttribute('data-placeholder') || '');
    const ed = eds.find(isFu) || eds[eds.length - 1];
    if (ed) { ed.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); ed.focus(); ed.click(); return true; }
  }
  return false;
})()
    `;
    try {
      return !!await this.session.evaluate(js, false);
    } catch {
      return false;
    }
  }
  /** Press a key chord via CDP (keyDown + keyUp). Modifier bits per CDP:
   *  Alt=1, Ctrl=2, Meta=4, Shift=8. */
  async pressKey(key, code, vk, mods = {}) {
    if (!this.session) {
      throw new Error("CDP session not connected");
    }
    let modifiers = 0;
    if (mods.alt)
      modifiers |= 1;
    if (mods.ctrl)
      modifiers |= 2;
    if (mods.meta)
      modifiers |= 4;
    if (mods.shift)
      modifiers |= 8;
    const base = {
      modifiers,
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk
    };
    await this.session.call("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await this.session.call("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
  /** Fast tile close: focus the tile, then send Ctrl+W (Cursor's close-tile
   *  shortcut; Ctrl+D is OPEN/new-tile, not close). Far quicker than driving the
   *  tile menu. Verifies the SPECIFIC agent's tile is gone, so a mis-focus or a
   *  swallowed chord can't close the wrong one; returns false if it's still
   *  present (the caller falls back to the menu close). */
  async closeAgentTileFast(agentId) {
    if (!this.session)
      return false;
    const focused = await this.focusAgent(agentId);
    if (!focused)
      return false;
    await this.sleep(80);
    try {
      await this.pressKey("w", "KeyW", 87, { ctrl: true });
    } catch {
      return false;
    }
    const goneJs = `
(function() {
  const TARGET = ${JSON.stringify(agentId)};
  const tiles = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
  function agentIdOf(node) {
    const k = Object.keys(node).find(x =>
      x.startsWith('__reactFiber$') || x.startsWith('__reactInternalInstance$')
    );
    let f = k ? node[k] : null, steps = 0;
    while (f && steps++ < 40) {
      const p = f.memoizedProps;
      if (p && typeof p === 'object' && typeof p.agentId === 'string') return p.agentId;
      f = f.return;
    }
    return null;
  }
  return !tiles.some(t => agentIdOf(t) === TARGET);
})()
    `;
    return !!await this.pollEval(goneJs, 900, 50);
  }
  /** Close the tile for agentId. Returns true only after the target tile is gone. */
  async closeAgentTile(agentId) {
    if (!this.session)
      return false;
    const triggerJs = `
(function() {
  const TARGET = ${JSON.stringify(agentId)};
  function tileRoots() {
    const tiled = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
    if (tiled.length > 0) return tiled;
    return [];
  }
  function agentIdOf(node) {
    const k = Object.keys(node).find(x =>
      x.startsWith('__reactFiber$') || x.startsWith('__reactInternalInstance$')
    );
    let f = k ? node[k] : null, steps = 0;
    while (f && steps++ < 40) {
      const p = f.memoizedProps;
      if (p && typeof p === 'object' && typeof p.agentId === 'string') return p.agentId;
      f = f.return;
    }
    return null;
  }
  function visMenu() {
    return [...document.querySelectorAll('[role^="menuitem"],[role="option"]')].filter(e => e.offsetParent);
  }
  function tileMenuTrigger(tile, idx) {
    const inTile = tile?.querySelector('[aria-label="Tile actions"],.glass-agent-conversation-tiling__menu-trigger');
    if (inTile) return inTile;
    const actions = [...document.querySelectorAll('[aria-label="Tile actions"],.glass-agent-conversation-tiling__menu-trigger')]
      .filter(e => e.offsetParent);
    return actions[idx] || null;
  }
  const tiles = tileRoots();
  if (tiles.length <= 1) return false;
  let idx = -1;
  for (let i = 0; i < tiles.length; i++) {
    if (agentIdOf(tiles[i]) === TARGET) { idx = i; break; }
  }
  if (idx < 0) return false;
  const trig = tileMenuTrigger(tiles[idx], idx);
  if (!trig) return false;
  const r = trig.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, idx, count: tiles.length };
})()
    `;
    const closeJs = `
(function() {
  const items = [...document.querySelectorAll('[role^="menuitem"],[role="option"]')]
    .filter(e => e.offsetParent);
  const close = items.find(e => (e.textContent || '').trim().toLowerCase().startsWith('close'));
  if (!close) return false;
  const r = close.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (close.textContent || '').trim() };
})()
    `;
    const goneJs = `
(function() {
  const TARGET = ${JSON.stringify(agentId)};
  function tileRoots() {
    const tiled = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
    if (tiled.length > 0) return tiled;
    return [];
  }
  function agentIdOf(node) {
    const k = Object.keys(node).find(x =>
      x.startsWith('__reactFiber$') || x.startsWith('__reactInternalInstance$')
    );
    let f = k ? node[k] : null, steps = 0;
    while (f && steps++ < 40) {
      const p = f.memoizedProps;
      if (p && typeof p === 'object' && typeof p.agentId === 'string') return p.agentId;
      f = f.return;
    }
    return null;
  }
  return !tileRoots().some(t => agentIdOf(t) === TARGET);
})()
    `;
    try {
      const trigger = await this.session.evaluate(triggerJs, false);
      if (!trigger || typeof trigger.x !== "number" || typeof trigger.y !== "number") {
        return false;
      }
      await this.clickAt(trigger.x, trigger.y);
      const close = await this.pollEval(closeJs, 700, 40);
      if (!close || typeof close.x !== "number" || typeof close.y !== "number") {
        return false;
      }
      await this.clickAt(close.x, close.y);
      return !!await this.pollEval(goneJs, 1200, 60);
    } catch {
      return false;
    }
  }
  /** Close the tile at a given index (for tiles with no resolvable agentId).
   *  Returns true once the tile count drops. */
  async closeTileByIndex(index) {
    if (!this.session || !Number.isInteger(index) || index < 0)
      return false;
    const triggerJs = `
(function() {
  const IDX = ${index};
  const tiles = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
  if (tiles.length <= 1 || IDX >= tiles.length) return false;
  function tileMenuTrigger(tile, idx) {
    const inTile = tile?.querySelector('[aria-label="Tile actions"],.glass-agent-conversation-tiling__menu-trigger');
    if (inTile) return inTile;
    const actions = [...document.querySelectorAll('[aria-label="Tile actions"],.glass-agent-conversation-tiling__menu-trigger')]
      .filter(e => e.offsetParent);
    return actions[idx] || null;
  }
  const trig = tileMenuTrigger(tiles[IDX], IDX);
  if (!trig) return false;
  const r = trig.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, count: tiles.length };
})()
    `;
    const closeJs = `
(function() {
  const items = [...document.querySelectorAll('[role^="menuitem"],[role="option"]')]
    .filter(e => e.offsetParent);
  const close = items.find(e => (e.textContent || '').trim().toLowerCase().startsWith('close'));
  if (!close) return false;
  const r = close.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()
    `;
    try {
      const trigger = await this.session.evaluate(triggerJs, false);
      if (!trigger || typeof trigger.x !== "number" || typeof trigger.y !== "number") {
        return false;
      }
      const before = typeof trigger.count === "number" ? trigger.count : 0;
      await this.clickAt(trigger.x, trigger.y);
      const close = await this.pollEval(closeJs, 700, 40);
      if (!close || typeof close.x !== "number" || typeof close.y !== "number") {
        return false;
      }
      await this.clickAt(close.x, close.y);
      const droppedJs = `document.querySelectorAll('.glass-agent-conversation-tiling__tile').length < ${before}`;
      return !!await this.pollEval(droppedJs, 1200, 60);
    } catch {
      return false;
    }
  }
  async queryTileState() {
    const js = `
(function() {
  // Multi-tile: .glass-agent-conversation-tiling__tile
  // Single-pane (one agent): .agent-panel-conversation-shell \u2014 no tiling wrapper
  function tileRoots() {
    const tiled = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
    if (tiled.length > 0) return tiled;
    const shell = document.querySelector('.agent-panel-conversation-shell');
    return shell ? [shell] : [];
  }
  const tiles = tileRoots();

  function agentIdOf(node) {
    const k = Object.keys(node).find(x =>
      x.startsWith('__reactFiber$') || x.startsWith('__reactInternalInstance$')
    );
    let f = k ? node[k] : null, steps = 0;
    while (f && steps++ < 40) {
      const p = f.memoizedProps;
      if (p && typeof p === 'object' && typeof p.agentId === 'string') return p.agentId;
      f = f.return;
    }
    return null;
  }

  // A check_messages MCP call counts as "connected / held open" only while it is
  // *currently running* \u2014 a live tool card (or collapsible action) that names
  // "Check Messages in jefr" and still carries a running/shimmer indicator.
  // Completed ("Ran ...") cards left in scrollback are ignored, so historical
  // transcript text can never make a tile look permanently connected.
  function mcpRunningIn(t) {
    const toolCards = [...t.querySelectorAll('[data-message-kind="tool"]')];
    for (const m of toolCards) {
      const txt = m.textContent || '';
      if (!/check\\s*messages/i.test(txt) || !/jefr/i.test(txt)) continue;
      const status = (m.getAttribute('data-tool-status') || '').toLowerCase();
      const cls = typeof m.className === 'string' ? m.className : '';
      const running =
        /run|load|pend|progress|stream|active/.test(status) ||
        /with-stop/.test(cls) ||
        !!m.querySelector('[class*="shimmer"],[class*="spinner"],.codicon-modifier-spin,[data-state="stop"],[class*="with-stop"]');
      if (running) return true;
    }
    // Fallback for builds that don't tag tool cards: a live collapsible-action
    // shimmer naming check messages is also an in-progress call.
    const shimmers = [...t.querySelectorAll('.ui-collapsible-shimmer')];
    for (const s of shimmers) {
      if (/check\\s*messages/i.test(s.textContent || '')) return true;
    }
    return false;
  }

  // The server-drop fingerprint, confirmed by CDP-inspecting a live drop: when the
  // held-open call dies (server crash/restart, transport break, client abort),
  // Cursor marks the in-flight check_messages tool card as **Cancelled** \u2014 it
  // carries data-tool-status="cancelled" and renders "Cancelled Check Messages in
  // jefr". A healthy call reads "Running\u2026" then "Ran" (status running/completed),
  // so only a cancelled/failed/errored status is a drop. We key off the card's own
  // status (attribute + its lead status word) \u2014 NEVER the delivered reply text \u2014
  // so a reply that merely contains "error" can't false-trip it.
  function mcpErroredIn(t) {
    const toolCards = [...t.querySelectorAll('[data-message-kind="tool"]')];
    // Only the MOST RECENT jefr check_messages card matters: an agent that
    // dropped then reconnected leaves an old "Cancelled" card up the transcript
    // while its newest card reads "Running"/"Ran". Judging by the latest card
    // alone means a recovered agent isn't stuck looking dropped.
    let last = null;
    for (const m of toolCards) {
      const txt = m.textContent || '';
      if (!/check\\s*messages/i.test(txt) || !/jefr/i.test(txt)) continue;
      last = m;
    }
    if (!last) return false;
    const status = (last.getAttribute('data-tool-status') || '').toLowerCase();
    if (/cancel|error|fail|abort|reject/.test(status)) return true;
    // Fallback for builds without the status attribute: the card text begins with
    // its status word, e.g. "CancelledCheck Messages in jefr".
    const txt = last.textContent || '';
    if (/^\\s*(cancel|failed|errored|aborted|rejected)/i.test(txt)) return true;
    return false;
  }

  // The agent is actively WORKING when any tool call is mid-flight: a tool card in
  // a running/loading status, or carrying a live shimmer/spinner. This is true
  // even when the submit button isn't in "stop" mode (tool execution happens
  // between text generations). Without it, a long turn between check_messages
  // calls reads as idle and can be misflagged as dropped. Verified via CDP: a
  // working tile has a tool card with data-tool-status="loading".
  function toolWorkingIn(t) {
    const cards = [...t.querySelectorAll('[data-message-kind="tool"]')];
    for (const m of cards) {
      const status = (m.getAttribute('data-tool-status') || '').toLowerCase();
      const cls = typeof m.className === 'string' ? m.className : '';
      const running =
        /run|load|pend|progress|stream/.test(status) ||
        /with-stop/.test(cls) ||
        !!m.querySelector('[class*="shimmer"],[class*="spinner"],.codicon-modifier-spin,[data-state="stop"]');
      if (running) return true;
    }
    return false;
  }

  return tiles.map((t, i) => {
    const submit = t.querySelector('.ui-prompt-input-submit-button');
    const aria = submit?.getAttribute('aria-label') || '';
    const generating = submit?.getAttribute('data-state') === 'stop' || /stop generation/i.test(aria);

    const sh = t.querySelector('.ui-collapsible-action.ui-collapsible-shimmer')?.textContent || '';
    const planning = /planning\\s+next\\s+move/i.test(sh);

    const mcpRunning = mcpRunningIn(t);
    const toolWorking = toolWorkingIn(t);
    // A cancelled-card drop only counts when the tile isn't otherwise busy \u2014 an
    // agent that recovered and is generating / running a tool again must not read
    // as dropped from a stale "Cancelled" card left up the transcript.
    const mcpErrored =
      !mcpRunning && !generating && !planning && !toolWorking && mcpErroredIn(t);

    // "Worked for ..." completion stamp = the turn ended (MCP cut out). Prefer the
    // live status/followup area; fall back to the recent tail. We do NOT scan the
    // whole transcript, so an old stamp from a prior turn won't mark a live tile.
    const statusText = [
      ...[...t.querySelectorAll('.glass-chat-status-bar__segment-label')].map(e => e.textContent || ''),
      t.querySelector('.agent-panel-followup-status-area')?.textContent || '',
    ].join(' ').replace(/\\s+/g, ' ').trim();
    const full = (t.innerText || '').replace(/\\s+/g, ' ');
    const tail = full.length > 400 ? full.slice(-400) : full;
    const worked = /worked for\\s+[\\dhms ]+/i.test(statusText) || /worked for\\s+[\\dhms ]+/i.test(tail);

    const model = t.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim() || '';

    // Precedence: a live MCP call wins over planning/generating, so a transient
    // "Planning next moves" shimmer can't demote a held-open connection (which
    // previously flip-flopped the state, inflating connect counts and resetting
    // uptime).
    let state = 'idle';
    if (mcpRunning) state = 'mcp_connected';
    else if (planning) state = 'planning';
    else if (generating) state = 'generating';
    else if (toolWorking) state = 'generating';

    return {
      index: i,
      agentId: agentIdOf(t),
      model,
      state,
      mcpVisible: mcpRunning,
      mcpErrored,
      generating: generating || toolWorking,
      planning,
      worked,
    };
  });
})()
    `;
    const result = await this.session.evaluate(js, false);
    return result || [];
  }
  emitStatus(status) {
    const changed = JSON.stringify(status) !== JSON.stringify(this.lastStatus);
    this.lastStatus = status;
    if (changed) {
      this.emit("status", status);
    }
  }
};
var monitor = null;
function getCdpMonitor() {
  if (!monitor) {
    monitor = new CdpMonitor();
  }
  return monitor;
}
function stopCdpMonitor() {
  if (monitor) {
    monitor.stop();
    monitor = null;
  }
}

// src/tile-state.ts
var MISSING_TILE_GRACE_MS = 1e4;
var MCP_GRACE_MS = 8e3;
var BUSY_GRACE_MS = 8e3;
function isLiveState(state) {
  return state !== "idle";
}
function isConnectedState(state) {
  return state === "mcp_connected" || state === "waiting";
}
function isServerDropped(a) {
  return a.connectCount > 0 && !isLiveState(a.state) && !a.worked && (a.mcpErrored || a.queueCount > 0 || !a.heartbeatAlive);
}
function resolveState(rawState, heartbeatState, loopAlive, mcpErrored, busyAlive) {
  if (rawState === "mcp_connected")
    return "mcp_connected";
  if (rawState === "generating" || rawState === "planning")
    return rawState;
  if (mcpErrored)
    return "idle";
  if (loopAlive)
    return "mcp_connected";
  if (busyAlive)
    return "generating";
  if (heartbeatState && rawState === "idle")
    return heartbeatState;
  return rawState;
}
var TileStateManager = class {
  agents = /* @__PURE__ */ new Map();
  listeners = [];
  /** Resolve a stable tracking id for a tile. Prefers the real React-fiber
   *  agentId. When that isn't available (a freshly-opened tile, or a flaky poll
   *  where the fiber walk missed), reuse the agent already tracked in this tile
   *  slot so a momentary miss never drops a live tile; otherwise synthesize a
   *  slot id so the new tile still appears on the Agents page. */
  resolveTileId(tile, seen) {
    if (tile.agentId)
      return tile.agentId;
    for (const a of this.agents.values()) {
      if (a.tileIndex === tile.index && !seen.has(a.agentId)) {
        return a.agentId;
      }
    }
    return `tile:${tile.index}`;
  }
  /** Update state from CDP tile info. Returns transitions that occurred.
   *  `forgetMs` drops vanished agents from the map after that long unseen.
   *  Fresh MCP heartbeats override an otherwise-idle CDP tile, because the DOM
   *  can look idle while the agent is actively doing tool work. */
  update(tiles, queueCounts, forgetMs = 5 * 6e4, heartbeatStates = /* @__PURE__ */ new Map()) {
    const now = Date.now();
    const transitions = [];
    const seen = /* @__PURE__ */ new Set();
    for (const tile of tiles) {
      const id = this.resolveTileId(tile, seen);
      seen.add(id);
      const existing = this.agents.get(id);
      const rawMcp = tile.state === "mcp_connected";
      const lastMcpAt = rawMcp ? now : existing?.lastMcpAt ?? 0;
      const loopAlive = !!existing && existing.connectCount > 0 && lastMcpAt > 0 && now - lastMcpAt < MCP_GRACE_MS;
      const rawBusy = tile.state === "generating" || tile.state === "planning";
      const lastBusyAt = rawBusy ? now : existing?.lastBusyAt ?? 0;
      const busyAlive = lastBusyAt > 0 && now - lastBusyAt < BUSY_GRACE_MS;
      const state = resolveState(
        tile.state,
        heartbeatStates.get(id),
        loopAlive,
        tile.mcpErrored,
        busyAlive
      );
      if (!existing) {
        const newState = {
          agentId: id,
          tileIndex: tile.index,
          state,
          model: tile.model,
          queueCount: queueCounts.get(id) || 0,
          firstSeen: now,
          connectedSince: isConnectedState(state) ? now : 0,
          lastMcpAt,
          lastBusyAt,
          // A "Worked for…" completion stamp proves the tile already ran a full
          // MCP turn, so even if we never caught it live (it finished before our
          // first poll, or was adopted via Refresh after the turn ended) it has
          // connected at least once. Seed connectCount so the present stamp can
          // classify it as a re-primeable "Dropped" tile instead of falling
          // through to a plain, unreconnectable "Down".
          connectCount: isConnectedState(state) || tile.worked ? 1 : 0,
          reconnectCount: 0,
          reconnectStreak: 0,
          lastReconnectAt: 0,
          worked: tile.worked,
          mcpErrored: tile.mcpErrored,
          heartbeatAlive: heartbeatStates.has(id),
          lastSeen: now,
          lastConnectedMs: 0
        };
        this.agents.set(id, newState);
        transitions.push({ type: "new_agent", agentId: id, to: state });
        if (isConnectedState(state)) {
          transitions.push({ type: "connected", agentId: id, to: state });
        }
      } else {
        const prevState = existing.state;
        existing.tileIndex = tile.index;
        existing.model = tile.model;
        existing.queueCount = queueCounts.get(id) || 0;
        existing.worked = tile.worked;
        existing.mcpErrored = tile.mcpErrored;
        existing.heartbeatAlive = heartbeatStates.has(id);
        existing.lastMcpAt = lastMcpAt;
        existing.lastBusyAt = lastBusyAt;
        existing.lastSeen = now;
        if (prevState !== state) {
          existing.state = state;
          transitions.push({
            type: "state_changed",
            agentId: id,
            from: prevState,
            to: state
          });
          const enteredLoop = isConnectedState(state) && !isConnectedState(prevState) && (existing.connectCount === 0 || !isLiveState(prevState));
          const wentDown = !isLiveState(state) && isLiveState(prevState);
          if (enteredLoop) {
            if (!existing.connectedSince)
              existing.connectedSince = now;
            existing.connectCount++;
            existing.reconnectStreak = 0;
            transitions.push({ type: "connected", agentId: id, to: state });
          } else if (wentDown && existing.connectCount > 0) {
            const heldMs = existing.connectedSince ? now - existing.connectedSince : 0;
            if (heldMs > 0)
              existing.lastConnectedMs = heldMs;
            transitions.push({
              type: "disconnected",
              agentId: id,
              from: prevState,
              to: state,
              connectedMs: heldMs > 0 ? heldMs : void 0
            });
            existing.connectedSince = 0;
          }
        }
        if (existing.connectCount === 0 && tile.worked) {
          existing.connectCount = 1;
        }
      }
    }
    for (const [agentId, agent] of this.agents) {
      if (seen.has(agentId))
        continue;
      if (agentId.startsWith("tile:")) {
        this.agents.delete(agentId);
        continue;
      }
      if (now - agent.lastSeen <= MISSING_TILE_GRACE_MS) {
        continue;
      }
      if (agent.tileIndex >= 0) {
        const prevState = agent.state;
        const prevConnectedSince = agent.connectedSince;
        agent.tileIndex = -1;
        agent.connectedSince = 0;
        agent.lastMcpAt = 0;
        agent.lastBusyAt = 0;
        agent.worked = false;
        agent.mcpErrored = false;
        agent.heartbeatAlive = false;
        if (prevState !== "idle") {
          agent.state = "idle";
          const heldMs = prevConnectedSince ? now - prevConnectedSince : 0;
          if (heldMs > 0)
            agent.lastConnectedMs = heldMs;
          if (prevState === "mcp_connected") {
            transitions.push({
              type: "disconnected",
              agentId,
              from: prevState,
              to: "idle",
              connectedMs: heldMs > 0 ? heldMs : void 0
            });
          }
        }
      }
      if (now - agent.lastSeen > forgetMs) {
        this.agents.delete(agentId);
      }
    }
    if (transitions.length > 0) {
      for (const listener of this.listeners) {
        listener(transitions);
      }
    }
    return transitions;
  }
  /** Get all tracked agents. */
  getAgents() {
    return [...this.agents.values()];
  }
  /** Get a specific agent by ID. */
  getAgent(agentId) {
    return this.agents.get(agentId);
  }
  /** Get agents that need reconnection. Two reconnectable end-states, both
   *  visible, previously connected, and no longer live:
   *    • clean cut-off — the turn ended with a "Worked for…" completion stamp.
   *    • server drop   — the loop died abruptly (errored check_messages card, or
   *                      messages stranded in the queue) with NO stamp; without
   *                      this arm it would fall through to a plain "down" tile and
   *                      never be re-primed, stranding its queue forever.
   *  The stamp / error / queue gates distinguish a real drop from a tile that's
   *  merely idle (freshly spawned, or the user is mid-type), avoiding needless
   *  re-primes. */
  getDroppedAgents() {
    return this.getAgents().filter(
      (a) => (
        // Real agentId only — never try to reconnect a synthetic slot id, which
        // the workflow can't target (no fiber agentId to focus).
        !a.agentId.startsWith("tile:") && // Must be visible (tileIndex >= 0)
        a.tileIndex >= 0 && // Must have connected before (so it's a DROP, not a new tile)
        a.connectCount > 0 && // Not currently live (MCP loop, working heartbeat, generating, or planning)
        !isLiveState(a.state) && // A clean cut-out (completion stamp) OR an abrupt server drop.
        (a.worked || isServerDropped(a))
      )
    );
  }
  /** Mark a reconnect attempt for an agent. */
  markReconnectAttempt(agentId) {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.reconnectCount++;
      agent.reconnectStreak++;
      agent.lastReconnectAt = Date.now();
    }
  }
  /** Remove an agent from tracking (e.g., tile closed). */
  forgetAgent(agentId) {
    this.agents.delete(agentId);
  }
  /** Listen for state transitions. */
  onTransition(listener) {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0)
        this.listeners.splice(idx, 1);
    };
  }
  /** Convert agent state to the view format expected by the webview. */
  toAgentViews() {
    return this.getAgents().filter((a) => a.tileIndex >= 0).map((a) => ({
      id: a.agentId,
      // "connected" = a live state AND the tile has actually reached the MCP
      // loop at least once (connectCount > 0). Requiring connectCount closes
      // the pre-first-connect gap: while a fresh tile is still being primed it
      // flaps idle ↔ generating/planning, and the grace window in resolveState
      // can't smooth that yet (it only arms after the first real connect), so
      // a bare isLiveState() check would bounce the connected count 0↔1. Once
      // the tile is through the loop the grace window keeps this steady.
      connected: isLiveState(a.state) && a.connectCount > 0,
      // Preserve CDP state for UI — the type now supports all states
      state: a.state,
      // A clean cut-out: previously connected, now idle, "Worked for..."
      // stamp present. Lets the UI show a distinct reconnectable state.
      dropped: a.connectCount > 0 && !isLiveState(a.state) && a.worked,
      // An abrupt server drop (no clean stamp) — surfaced separately so the UI
      // can flag it distinctly from a polite cut-off. Synthetic slot ids can't
      // be re-primed, so never mark them.
      serverDropped: !a.agentId.startsWith("tile:") && isServerDropped(a),
      queueCount: a.queueCount,
      connectCount: a.connectCount,
      reconnectCount: a.reconnectCount,
      connectedSince: a.connectedSince,
      // How long the last connection held before dropping — surfaced so a
      // dropped tile can show "connected for X" even though connectedSince
      // has been cleared back to 0.
      lastConnectedMs: a.lastConnectedMs,
      model: a.model,
      tileIndex: a.tileIndex
    }));
  }
};

// src/extension.ts
var mainPanel;
var pollTimer2;
var lastQuestionId;
var lastReplyTimestamp;
var lastQueueCount;
var lastAllQueuesJson;
var lastCardValid;
var chatTriggered = false;
var extensionVersion = "0.0.0";
var currentDataDir = "";
var remotePollTimer;
var heartbeatTimer;
var lastReplyContent;
var lastRemoteQuestionId;
var idleTimer;
var lastActivityTime = Date.now();
var selectedAgentId;
var lastAgentListJson;
var autoReconnect = false;
var RECONNECT_DEBOUNCE_MS = 45e3;
var AGENT_FORGET_MS = 5 * 6e4;
var MAX_RECONNECT_ATTEMPTS = 3;
var GC_AGENT_DIRS = false;
var agentStats = /* @__PURE__ */ new Map();
var tileStateManager = new TileStateManager();
var cdpEnabled = true;
var lastCdpStatus = null;
function startCdpMonitoring() {
  if (!cdpEnabled)
    return;
  const monitor2 = getCdpMonitor();
  monitor2.on("status", (status) => {
    const wasCdp = lastCdpStatus?.connected ?? false;
    lastCdpStatus = status;
    if (wasCdp !== status.connected) {
      dlog(
        `CDP ${status.connected ? "connected" : "disconnected"}${status.error ? " \u2014 " + status.error : ""}`,
        status.connected ? "info" : "warn"
      );
    }
    if (!status.connected) {
      return;
    }
    const queueCounts = /* @__PURE__ */ new Map();
    const heartbeatStates = /* @__PURE__ */ new Map();
    for (const tile of status.tiles) {
      if (tile.agentId) {
        queueCounts.set(tile.agentId, getQueueCountFor(tile.agentId));
        const heartbeat = getAgentStatusFor(tile.agentId);
        if (heartbeat.alive) {
          heartbeatStates.set(tile.agentId, heartbeat.state);
        }
      }
    }
    const transitions = tileStateManager.update(
      status.tiles,
      queueCounts,
      AGENT_FORGET_MS,
      heartbeatStates
    );
    for (const t of transitions) {
      const who = t.agentId.slice(0, 8);
      if (t.type === "connected")
        dlog(`agent ${who} connected (${t.to})`);
      else if (t.type === "disconnected") {
        const held = typeof t.connectedMs === "number" && t.connectedMs > 0 ? ` after ${fmtHeldDuration(t.connectedMs)} connected` : "";
        dlog(`agent ${who} dropped (${t.from} \u2192 ${t.to})${held}`, "warn");
      } else if (t.type === "new_agent")
        dlog(`agent ${who} appeared (${t.to})`);
    }
    if (autoReconnect && !workflowProc && !healingTile) {
      void maintainPool();
    }
    gcDeadAgentDirs();
    pushAgentListFromCdp();
  });
  monitor2.start().catch((e) => {
    console.error("CDP monitor failed to start:", e);
  });
}
function fmtHeldDuration(ms) {
  if (ms <= 0)
    return "0s";
  const s = Math.floor(ms / 1e3);
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const sec = s % 60;
  if (h > 0)
    return `${h}h ${m}m`;
  if (m > 0)
    return `${m}m ${sec}s`;
  return `${sec}s`;
}
function pushAgentListFromCdp() {
  if (!mainPanel)
    return;
  let agents = tileStateManager.toAgentViews();
  if (agents.length === 0) {
    pushAgentListFromHeartbeats(true);
    return;
  }
  resolveSpawnConnectingId(agents);
  recordConnectTime(agents);
  lastPushedAgentIds = new Set(agents.map((a) => a.id));
  const payload = {
    agents: agents.map((a) => ({ ...a, connectMs: agentConnectMs.get(a.id) })),
    selected: selectedAgentId || null,
    autoReconnect,
    targetAgentCount: TARGET_AGENT_COUNT,
    cdpConnected: lastCdpStatus?.connected ?? false,
    connectingAgentId: workflowProc ? activeWorkflowAgentId ?? null : null,
    connectingSince: workflowProc ? workflowStartedAt : 0
  };
  writeCdpStatusFile(agents);
  setSelectedAgentId(selectedAgentId);
  const json = JSON.stringify(payload);
  if (json !== lastAgentListJson) {
    lastAgentListJson = json;
    mainPanel.webview.postMessage({ type: "agentList", ...payload });
  }
}
function writeCdpStatusFile(agents) {
  try {
    const statusFile = path3.join(os3.homedir(), ".moyu-message", "cdp-status.json");
    const status = {
      ts: Date.now(),
      cdpConnected: lastCdpStatus?.connected ?? false,
      pageTitle: lastCdpStatus?.pageTitle ?? null,
      agents: agents.map((a) => ({
        id: a.id,
        state: a.state,
        connected: a.connected,
        model: a.model,
        tileIndex: a.tileIndex,
        connectedSince: a.connectedSince,
        queueCount: a.queueCount
      }))
    };
    fs3.writeFileSync(statusFile, JSON.stringify(status, null, 2), "utf-8");
  } catch {
  }
}
var workflowProc;
var activeWorkflowAgentId;
var spawnBaselineAgentIds;
var lastPushedAgentIds = /* @__PURE__ */ new Set();
var workflowStartedAt = 0;
var agentConnectMs = /* @__PURE__ */ new Map();
function resolveSpawnConnectingId(agents) {
  if (!workflowProc || activeWorkflowAgentId || !spawnBaselineAgentIds)
    return;
  const fresh = agents.find(
    (a) => !a.id.startsWith("tile:") && !spawnBaselineAgentIds.has(a.id)
  );
  if (fresh)
    activeWorkflowAgentId = fresh.id;
}
function isConnectingTarget(aid) {
  if (!workflowProc)
    return false;
  if (activeWorkflowAgentId)
    return aid === activeWorkflowAgentId;
  if (spawnBaselineAgentIds) {
    return aid.startsWith("tile:") || !spawnBaselineAgentIds.has(aid);
  }
  return false;
}
function recordConnectTime(agents) {
  if (!workflowProc || !activeWorkflowAgentId || !workflowStartedAt)
    return;
  if (agentConnectMs.has(activeWorkflowAgentId))
    return;
  const a = agents.find((x) => x.id === activeWorkflowAgentId);
  const mcpLoop = a?.state === "mcp_connected" || a?.state === "waiting" || a?.state === "working";
  if (!mcpLoop)
    return;
  const ms = Date.now() - workflowStartedAt;
  agentConnectMs.set(activeWorkflowAgentId, ms);
  postWorkflow({
    type: "workflowOutput",
    stream: "stdout",
    line: `[jefr] agent ${activeWorkflowAgentId.slice(0, 8)} connected in ${(ms / 1e3).toFixed(1)}s`
  });
}
var WORKFLOW_CONNECT_RE = /workflow:\s+(?:MCP connected|reconnected MCP)\s+in\s+([\d.]+)s\s+\(agent\s+([^)]+)\)/i;
function maybeRecordWorkflowConnect(line) {
  const m = WORKFLOW_CONNECT_RE.exec(line);
  if (!m)
    return;
  const secs = parseFloat(m[1]);
  const id = m[2].trim();
  if (!isFinite(secs) || !id || id === "None")
    return;
  agentConnectMs.set(id, Math.round(secs * 1e3));
  lastAgentListJson = void 0;
  pushAgentList();
}
function bundledWorkflowScript() {
  return path3.join(__dirname, "..", "..", "automation", "workflow.py");
}
var resolvedWorkflowScript;
var resolvedWorkflowScriptFor;
function resolveWorkflowScript() {
  const wsKey = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath).join("|");
  if (resolvedWorkflowScript !== void 0 && resolvedWorkflowScriptFor === wsKey) {
    return resolvedWorkflowScript || null;
  }
  const candidates = [bundledWorkflowScript()];
  for (const folder of vscode.workspace.workspaceFolders || []) {
    candidates.push(path3.join(folder.uri.fsPath, "automation", "workflow.py"));
  }
  resolvedWorkflowScript = candidates.find((p) => fs3.existsSync(p)) ?? "";
  resolvedWorkflowScriptFor = wsKey;
  return resolvedWorkflowScript || null;
}
var WORKFLOW_DEFAULT_MODEL = "Opus 4.8 1M Extra High Fast";
var TARGET_AGENT_COUNT = 5;
var pendingAgentAdds = 0;
var pendingAgentModel = WORKFLOW_DEFAULT_MODEL;
function queueAgentAdds(count, model) {
  pendingAgentModel = model && model.trim() || WORKFLOW_DEFAULT_MODEL;
  const current = tileStateManager.toAgentViews().length;
  const room = Math.max(0, TARGET_AGENT_COUNT - current - pendingAgentAdds);
  const toAdd = Math.max(0, Math.min(count, room));
  if (toAdd <= 0) {
    postWorkflow({
      type: "workflowOutput",
      stream: "stderr",
      line: `[jefr] Pool already full or filling (target ${TARGET_AGENT_COUNT}).`
    });
    return;
  }
  pendingAgentAdds += toAdd;
  postWorkflow({
    type: "workflowOutput",
    stream: "stdout",
    line: `[jefr] Filling pool: queued ${toAdd} agent${toAdd !== 1 ? "s" : ""} (target ${TARGET_AGENT_COUNT}).`
  });
  processAgentAddQueue();
}
function processAgentAddQueue() {
  if (pendingAgentAdds <= 0) {
    return;
  }
  if (workflowProc) {
    return;
  }
  const current = tileStateManager.toAgentViews().length;
  if (current >= TARGET_AGENT_COUNT) {
    pendingAgentAdds = 0;
    return;
  }
  pendingAgentAdds--;
  runWorkflow({ model: pendingAgentModel, keepTiles: true });
}
var healingTile = false;
function topUpPool() {
  if (workflowProc || pendingAgentAdds > 0 || healingTile)
    return;
  const tiles = tileStateManager.toAgentViews().length;
  if (tiles < TARGET_AGENT_COUNT) {
    queueAgentAdds(TARGET_AGENT_COUNT - tiles, WORKFLOW_DEFAULT_MODEL);
  }
}
var lastDirGcAt = 0;
var DIR_GC_INTERVAL_MS = 3e4;
function gcDeadAgentDirs() {
  const now = Date.now();
  if (now - lastDirGcAt < DIR_GC_INTERVAL_MS)
    return;
  if (workflowProc || healingTile)
    return;
  lastDirGcAt = now;
  const live = /* @__PURE__ */ new Set();
  for (const v of tileStateManager.toAgentViews())
    live.add(v.id);
  if (selectedAgentId)
    live.add(selectedAgentId);
  for (const id of listAgentDirIds()) {
    if (live.has(id))
      continue;
    if (getAgentStatusFor(id).alive)
      continue;
    tileStateManager.forgetAgent(id);
    agentStats.delete(id);
    forgetAgentDir(id);
    dlog(`reaped dead agent ${id.slice(0, 8)} (no tile, stale heartbeat)`);
  }
}
async function maintainPool() {
  if (!autoReconnect || workflowProc || healingTile || pendingAgentAdds > 0)
    return;
  const now = Date.now();
  const synth = tileStateManager.getAgents().find(
    (a) => a.agentId.startsWith("tile:") && a.tileIndex >= 0 && a.state === "idle" && now - a.firstSeen > 15e3
  );
  if (synth && cdpEnabled) {
    healingTile = true;
    dlog(`keep-connected: closing dead tile at index ${synth.tileIndex} (no agentId)`, "warn");
    try {
      const closed = await getCdpMonitor().closeTileByIndex(synth.tileIndex).catch(() => false);
      if (closed)
        tileStateManager.forgetAgent(synth.agentId);
    } finally {
      healingTile = false;
    }
    lastAgentListJson = void 0;
    pushAgentList();
    return;
  }
  const dropped = tileStateManager.getDroppedAgents();
  if (dropped.length > 0) {
    const stranded = dropped.find((a) => a.queueCount > 0);
    if (stranded) {
      dlog(
        `keep-connected: re-priming dropped agent ${stranded.agentId.slice(0, 8)} in place (${stranded.queueCount} queued)`,
        "warn"
      );
      postWorkflow({
        type: "workflowOutput",
        stream: "stdout",
        line: `[jefr] keep-connected: agent ${stranded.agentId.slice(0, 8)} dropped with ${stranded.queueCount} queued \u2014 re-priming in place to drain its queue`
      });
      tileStateManager.markReconnectAttempt(stranded.agentId);
      runWorkflow({ reconnect: true, agentId: stranded.agentId });
      return;
    }
    const victim = dropped[0];
    healingTile = true;
    dlog(`keep-connected: closing cut-off agent ${victim.agentId.slice(0, 8)} and replacing`, "warn");
    postWorkflow({
      type: "workflowOutput",
      stream: "stdout",
      line: `[jefr] keep-connected: agent ${victim.agentId.slice(0, 8)} cut out \u2014 closing its tile and spawning a replacement`
    });
    try {
      const closed = cdpEnabled ? await getCdpMonitor().closeAgentTile(victim.agentId).catch(() => false) : false;
      if (closed) {
        tileStateManager.forgetAgent(victim.agentId);
        agentStats.delete(victim.agentId);
        forgetAgentDir(victim.agentId);
        if (victim.agentId === selectedAgentId)
          selectAgent(void 0);
      } else {
        tileStateManager.markReconnectAttempt(victim.agentId);
        runWorkflow({ reconnect: true, agentId: victim.agentId });
        return;
      }
    } finally {
      healingTile = false;
    }
    lastAgentListJson = void 0;
    pushAgentList();
  }
  topUpPool();
}
async function closeDroppedTiles() {
  if (healingTile)
    return 0;
  const dropped = tileStateManager.getDroppedAgents();
  if (dropped.length === 0)
    return 0;
  let closedCount = 0;
  healingTile = true;
  try {
    for (const victim of dropped) {
      const ok = cdpEnabled ? await getCdpMonitor().closeAgentTile(victim.agentId).catch(() => false) : false;
      if (ok) {
        tileStateManager.forgetAgent(victim.agentId);
        agentStats.delete(victim.agentId);
        forgetAgentDir(victim.agentId);
        if (victim.agentId === selectedAgentId)
          selectAgent(void 0);
        closedCount++;
        dlog(`close-dropped: closed ${victim.agentId.slice(0, 8)}`);
      } else {
        dlog(`close-dropped: failed to close ${victim.agentId.slice(0, 8)}`, "error");
      }
    }
  } finally {
    healingTile = false;
  }
  lastAgentListJson = void 0;
  pushAgentList();
  return closedCount;
}
var resolvedPython;
function resolvePython() {
  if (resolvedPython !== void 0) {
    return resolvedPython;
  }
  const candidates = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
  for (const cmd of candidates) {
    try {
      const r = (0, import_child_process.spawnSync)(cmd, ["--version"], {
        encoding: "utf-8",
        windowsHide: true,
        timeout: 5e3
      });
      const out = `${r.stdout || ""}${r.stderr || ""}`;
      if (!r.error && (r.status === 0 || /python/i.test(out))) {
        resolvedPython = cmd;
        return cmd;
      }
    } catch {
    }
  }
  resolvedPython = null;
  return null;
}
function postWorkflow(message) {
  mainPanel?.webview.postMessage(message);
}
var DEBUG_LOG_MAX = 500;
var debugLogBuf = [];
function dlog(line, level = "info") {
  const entry = { ts: Date.now(), level, line };
  debugLogBuf.push(entry);
  if (debugLogBuf.length > DEBUG_LOG_MAX)
    debugLogBuf.shift();
  mainPanel?.webview.postMessage({ type: "debugLog", entry });
}
function sendDebugLogSnapshot() {
  mainPanel?.webview.postMessage({
    type: "debugLogSnapshot",
    entries: debugLogBuf
  });
}
function runWorkflow(opts) {
  if (workflowProc) {
    postWorkflow({
      type: "workflowOutput",
      stream: "stderr",
      line: "[jefr] A workflow is already running \u2014 stop it first."
    });
    return;
  }
  const py = resolvePython();
  if (!py) {
    postWorkflow({
      type: "workflowOutput",
      stream: "stderr",
      line: "[jefr] Python not found on PATH (tried python / py / python3)."
    });
    postWorkflow({ type: "workflowExit", code: null });
    return;
  }
  const script = opts.scriptPath || resolveWorkflowScript();
  if (!script) {
    postWorkflow({
      type: "workflowOutput",
      stream: "stderr",
      line: "[jefr] Workflow script not found. Open the jefr-cursor workspace (automation/workflow.py) or install the extension from that repo."
    });
    postWorkflow({ type: "workflowExit", code: null });
    return;
  }
  if (!fs3.existsSync(script)) {
    postWorkflow({
      type: "workflowOutput",
      stream: "stderr",
      line: `[jefr] Workflow script not found: ${script}`
    });
    postWorkflow({ type: "workflowExit", code: null });
    return;
  }
  const args = [script];
  if (opts.reconnect) {
    args.push("--reconnect");
    if (typeof opts.tile === "number" && Number.isInteger(opts.tile)) {
      args.push("--tile", String(opts.tile));
    }
    if (opts.agentId && opts.agentId.trim()) {
      args.push("--agent-id", opts.agentId.trim());
    }
  } else if (opts.autoPrompt && opts.autoPrompt.trim()) {
    args.push(opts.autoPrompt);
  }
  if (!opts.reconnect) {
    args.push("--model", opts.model && opts.model.trim() || WORKFLOW_DEFAULT_MODEL);
    if (opts.keepTiles !== false) {
      args.push("--keep-tiles");
    }
  }
  if (opts.opusPrompt && opts.opusPrompt.trim()) {
    args.push("--type-text", opts.opusPrompt);
  }
  if (typeof opts.maxSecs === "number" && isFinite(opts.maxSecs)) {
    args.push("--max-secs", String(opts.maxSecs));
  }
  if (typeof opts.enterInterval === "number" && isFinite(opts.enterInterval)) {
    args.push("--enter-interval", String(opts.enterInterval));
  }
  postWorkflow({ type: "workflowState", running: true });
  postWorkflow({
    type: "workflowOutput",
    stream: "stdout",
    line: `[jefr] workflow script: ${script}`
  });
  const shown = args.map((a) => /\s/.test(a) ? JSON.stringify(a) : a).join(" ");
  postWorkflow({
    type: "workflowOutput",
    stream: "stdout",
    line: `[jefr] $ ${py} ${shown}`
  });
  let proc;
  try {
    proc = (0, import_child_process.spawn)(py, args, {
      cwd: path3.dirname(script),
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" }
    });
  } catch (e) {
    postWorkflow({
      type: "workflowOutput",
      stream: "stderr",
      line: `[jefr] Failed to start: ${e.message}`
    });
    postWorkflow({ type: "workflowState", running: false });
    postWorkflow({ type: "workflowExit", code: null });
    return;
  }
  workflowProc = proc;
  dlog(
    opts.reconnect ? `workflow: reconnecting agent ${(opts.agentId || "?").slice(0, 8)}` : `workflow: spawning a new agent (model ${opts.model || WORKFLOW_DEFAULT_MODEL})`
  );
  activeWorkflowAgentId = opts.agentId && opts.agentId.trim() ? opts.agentId.trim() : void 0;
  spawnBaselineAgentIds = opts.reconnect || activeWorkflowAgentId ? void 0 : new Set(lastPushedAgentIds);
  workflowStartedAt = Date.now();
  if (activeWorkflowAgentId)
    agentConnectMs.delete(activeWorkflowAgentId);
  lastAgentListJson = void 0;
  pushAgentList();
  const pump = (buf, stream) => {
    const text = buf.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line.length > 0) {
        maybeRecordWorkflowConnect(line);
        postWorkflow({ type: "workflowOutput", stream, line });
      }
    }
  };
  proc.stdout?.on("data", (d) => pump(d, "stdout"));
  proc.stderr?.on("data", (d) => pump(d, "stderr"));
  proc.on("error", (e) => {
    postWorkflow({
      type: "workflowOutput",
      stream: "stderr",
      line: `[jefr] Process error: ${e.message}`
    });
  });
  proc.on("close", (code) => {
    dlog(`workflow exited with code ${code}`, code === 0 ? "info" : "warn");
    postWorkflow({
      type: "workflowOutput",
      stream: "stdout",
      line: `[jefr] workflow exited with code ${code}`
    });
    postWorkflow({ type: "workflowState", running: false });
    postWorkflow({ type: "workflowExit", code });
    if (workflowProc === proc) {
      workflowProc = void 0;
    }
    activeWorkflowAgentId = void 0;
    spawnBaselineAgentIds = void 0;
    lastAgentListJson = void 0;
    pushAgentList();
    processAgentAddQueue();
  });
}
function stopWorkflow() {
  pendingAgentAdds = 0;
  const proc = workflowProc;
  if (!proc) {
    postWorkflow({ type: "workflowState", running: false });
    return;
  }
  workflowProc = void 0;
  postWorkflow({ type: "workflowState", running: false });
  try {
    if (process.platform === "win32" && proc.pid) {
      (0, import_child_process.spawnSync)("taskkill", ["/pid", String(proc.pid), "/t", "/f"], {
        windowsHide: true
      });
    } else {
      proc.kill("SIGTERM");
    }
  } catch {
  }
}
var IDLE_TIMEOUT_MS = 5 * 60 * 1e3;
var STANDBY_MESSAGE = "Hello. IMPORTANT: STAND BY. Take NO action of any kind right now \u2014 do not run any tools, edit files, or make any changes. Just hold, keep the connection open, and wait for my next instruction.";
function resetIdleTimer() {
  lastActivityTime = Date.now();
}
function startIdleTimer() {
  if (idleTimer) {
    clearInterval(idleTimer);
  }
  idleTimer = setInterval(() => {
    if (!isCardValid()) {
      return;
    }
    if (Date.now() - lastActivityTime < IDLE_TIMEOUT_MS) {
      return;
    }
    const targets = tileStateManager.getAgents().filter(
      (a) => !a.agentId.startsWith("tile:") && a.tileIndex >= 0 && a.connectCount > 0 && // Online + idle = parked in the MCP loop (not generating/planning/working).
      (a.state === "mcp_connected" || a.state === "waiting") && a.queueCount === 0
    );
    if (targets.length === 0) {
      return;
    }
    dlog(
      `idle ${IDLE_TIMEOUT_MS / 6e4}m: stand-by nudge \u2192 ${targets.length} agent(s): ${targets.map((a) => a.agentId.slice(0, 8)).join(", ")}`
    );
    for (const a of targets) {
      const item = sendTextTo(a.agentId, STANDBY_MESSAGE);
      mainPanel?.webview.postMessage({
        type: "historyAppend",
        agentId: a.agentId,
        item: {
          id: item.id,
          kind: "text",
          text: STANDBY_MESSAGE,
          time: new Date(item.timestamp || Date.now()).toLocaleTimeString()
        }
      });
    }
    resetIdleTimer();
  }, 6e4);
}
function computeDataDir(workspaceFolders) {
  const rootDir = path3.join(os3.homedir(), ".moyu-message");
  if (workspaceFolders.length === 0) {
    return rootDir;
  }
  const primary = workspaceFolders[0].uri.fsPath;
  const hash = crypto2.createHash("md5").update(primary).digest("hex").slice(0, 12);
  return path3.join(rootDir, hash);
}
function readMcpDataDir(workspaceFolders = []) {
  const candidates = [
    path3.join(os3.homedir(), ".cursor", "mcp.json"),
    ...workspaceFolders.map((f) => path3.join(f.uri.fsPath, ".cursor", "mcp.json"))
  ];
  for (const p of candidates) {
    try {
      if (!fs3.existsSync(p)) {
        continue;
      }
      const config = JSON.parse(fs3.readFileSync(p, "utf-8"));
      const dir = config?.mcpServers?.jefr?.env?.MESSENGER_DATA_DIR;
      if (typeof dir === "string" && dir.trim()) {
        return dir.trim();
      }
    } catch {
    }
  }
  return void 0;
}
function activate(context) {
  extensionVersion = context.extension.packageJSON?.version || "0.0.0";
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  currentDataDir = readMcpDataDir(workspaceFolders) ?? computeDataDir(workspaceFolders);
  setDataDir(currentDataDir);
  migrateFromRootDir();
  setHistorySink((item) => {
    mainPanel?.webview.postMessage({
      type: "historyAppend",
      item: {
        id: item.id,
        kind: item.type,
        text: item.content,
        caption: item.caption,
        path: item.path,
        name: item.path ? path3.basename(item.path) : void 0,
        dataUrl: item.dataUrl,
        time: new Date(item.timestamp || Date.now()).toLocaleTimeString()
      }
    });
  });
  const provider = new MessengerViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("mcpMessenger.mainView", provider)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("mcpMessenger.setupMcp", () => {
      const workspaceFolders2 = vscode.workspace.workspaceFolders;
      if (!workspaceFolders2?.length) {
        vscode.window.showErrorMessage("Please open a workspace first");
        return;
      }
      const changedCount = setupMcpForFolders(workspaceFolders2);
      if (changedCount >= 0) {
        vscode.window.showInformationMessage(
          changedCount > 0 ? `MCP config installed to ${changedCount} workspace(s). Restart Cursor to apply.` : "MCP config already exists; no need to install again"
        );
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("mcpMessenger.removeMcp", () => {
      const workspaceFolders2 = vscode.workspace.workspaceFolders;
      if (!workspaceFolders2?.length) {
        return;
      }
      let removedCount = 0;
      for (const folder of workspaceFolders2) {
        if (removeMcpConfig(folder.uri.fsPath)) {
          removedCount++;
        }
      }
      vscode.window.showInformationMessage(
        removedCount > 0 ? `MCP config removed from ${removedCount} workspace(s)` : "No MCP config found to remove"
      );
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("mcpMessenger.sendFile", (uri) => {
      if (uri) {
        sendFile(uri.fsPath);
        vscode.window.showInformationMessage("File added to message queue");
      }
    })
  );
  startPolling();
  startRemotePolling();
  startHeartbeat();
  startIdleTimer();
  autoSetupMcp();
  startCdpMonitoring();
  setWorkspaceInfo(getWorkspaceName(), getWorkspacePath() || "");
  startLocalServer().then((port) => {
    console.log(`jefr console started: http://127.0.0.1:${port}`);
    const restored = readSelectedAgentId();
    if (restored) {
      selectAgent(restored);
    }
  }).catch((e) => {
    console.error("Failed to start console server:", e);
  });
  context.subscriptions.push(
    vscode.commands.registerCommand("mcpMessenger.openConsole", () => {
      const port = getServerPort();
      if (!port) {
        vscode.window.showWarningMessage("Console server is not running yet");
        return;
      }
      const url = `http://127.0.0.1:${port}`;
      vscode.env.openExternal(vscode.Uri.parse(url));
    })
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      if (event.added.length > 0) {
        autoSetupMcp(event.added);
      }
    })
  );
  context.subscriptions.push({
    dispose: () => {
      if (pollTimer2) {
        clearInterval(pollTimer2);
      }
    }
  });
}
function deactivate() {
  if (pollTimer2) {
    clearInterval(pollTimer2);
  }
  if (remotePollTimer) {
    clearInterval(remotePollTimer);
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  if (idleTimer) {
    clearInterval(idleTimer);
  }
  stopWorkflow();
  stopLocalServer();
  stopCdpMonitor();
}
function startPolling() {
  const poll = () => {
    if (!mainPanel) {
      return;
    }
    pushAgentList();
    const question = readQuestionFor(selectedAgentId);
    if (question) {
      if (question.id !== lastQuestionId) {
        mainPanel.webview.postMessage({ type: "showQuestion", data: question });
        lastQuestionId = question.id;
        pushQuestionToRemoteNow(question);
      }
    } else if (lastQuestionId) {
      mainPanel.webview.postMessage({ type: "clearQuestion" });
      lastQuestionId = void 0;
    }
    const reply = readReplyFor(selectedAgentId);
    if (reply && reply.timestamp !== lastReplyTimestamp) {
      mainPanel.webview.postMessage({ type: "showReply", data: reply });
      lastReplyTimestamp = reply.timestamp;
    } else if (!reply) {
      lastReplyTimestamp = void 0;
    }
    const cardValid = isCardValid();
    if (cardValid !== lastCardValid) {
      mainPanel.webview.postMessage({ type: "cardState", data: { active: true } });
      lastCardValid = cardValid;
    }
    const count = getQueueCountFor(selectedAgentId);
    if (count !== lastQueueCount) {
      mainPanel.webview.postMessage({ type: "queueCount", count });
      mainPanel.webview.postMessage({ type: "queueData", data: readQueueFor(selectedAgentId) });
      lastQueueCount = count;
    }
    pushAllQueues();
  };
  poll();
  pollTimer2 = setInterval(poll, 500);
}
function pushAgentListFromHeartbeats(cdpFallback = false) {
  if (!mainPanel) {
    return;
  }
  const now = Date.now();
  const roster = scanAllAgents();
  const { views: agents, dropped, prune } = reconcile(roster, agentStats, now, {
    forgetMs: AGENT_FORGET_MS,
    maxReconnects: MAX_RECONNECT_ATTEMPTS
  });
  for (const id of prune) {
    agentStats.delete(id);
    if (id === selectedAgentId) {
      selectedAgentId = void 0;
      writeSelectedAgentId(void 0);
      setSelectedAgentId(void 0);
      mainPanel.webview.postMessage({ type: "agentSelected", agentId: null });
    }
    if (GC_AGENT_DIRS) {
      forgetAgentDir(id);
    }
  }
  if (autoReconnect && !workflowProc) {
    const target = pickReconnect(dropped, agentStats, now, RECONNECT_DEBOUNCE_MS);
    if (target) {
      const s = agentStats.get(target);
      if (s) {
        s.reconnectCount++;
        s.reconnectsSinceConnect++;
        s.lastReconnectAt = now;
      }
      postWorkflow({
        type: "workflowOutput",
        stream: "stdout",
        line: `[jefr] auto-reconnect: agent ${target.slice(0, 8)} dropped \u2014 re-priming its tile`
      });
      runWorkflow({ reconnect: true, agentId: target });
    }
  }
  const droppedSet = new Set(dropped);
  const agentsWithDropped = agents.map((a) => ({
    ...a,
    dropped: !a.connected && droppedSet.has(a.id)
  }));
  writeCdpStatusFile(agents);
  resolveSpawnConnectingId(agentsWithDropped);
  recordConnectTime(agentsWithDropped);
  lastPushedAgentIds = new Set(agentsWithDropped.map((a) => a.id));
  const payload = {
    agents: agentsWithDropped.map((a) => ({
      ...a,
      connectMs: agentConnectMs.get(a.id)
    })),
    selected: selectedAgentId || null,
    autoReconnect,
    targetAgentCount: TARGET_AGENT_COUNT,
    cdpConnected: cdpFallback ? lastCdpStatus?.connected ?? false : false,
    connectingAgentId: workflowProc ? activeWorkflowAgentId ?? null : null,
    connectingSince: workflowProc ? workflowStartedAt : 0
  };
  setSelectedAgentId(selectedAgentId);
  const json = JSON.stringify(payload);
  if (json !== lastAgentListJson) {
    lastAgentListJson = json;
    mainPanel.webview.postMessage({ type: "agentList", ...payload });
  }
}
function pushAgentList() {
  if (!mainPanel) {
    return;
  }
  if (cdpEnabled && lastCdpStatus?.connected && tileStateManager.toAgentViews().length > 0) {
    pushAgentListFromCdp();
    return;
  }
  pushAgentListFromHeartbeats(cdpEnabled && (lastCdpStatus?.connected ?? false));
}
function selectAgent(agentId) {
  selectedAgentId = agentId && agentId.trim() ? agentId.trim() : void 0;
  writeSelectedAgentId(selectedAgentId);
  setSelectedAgentId(selectedAgentId);
  lastQuestionId = void 0;
  lastReplyTimestamp = void 0;
  lastQueueCount = void 0;
  lastAgentListJson = void 0;
  mainPanel?.webview.postMessage({
    type: "agentSelected",
    agentId: selectedAgentId || null
  });
  const reply = readReplyFor(selectedAgentId);
  if (reply) {
    mainPanel?.webview.postMessage({ type: "showReply", data: reply });
    lastReplyTimestamp = reply.timestamp;
  }
  const question = readQuestionFor(selectedAgentId);
  mainPanel?.webview.postMessage(
    question ? { type: "showQuestion", data: question } : { type: "clearQuestion" }
  );
  lastQuestionId = question?.id;
  mainPanel?.webview.postMessage({ type: "queueData", data: readQueueFor(selectedAgentId) });
  mainPanel?.webview.postMessage({ type: "queueCount", count: getQueueCountFor(selectedAgentId) });
  lastAllQueuesJson = void 0;
  pushAllQueues();
  pushAgentList();
}
function queueTarget(agentId) {
  return agentId === void 0 ? selectedAgentId : agentId;
}
function buildQueueGroups() {
  const groups = [];
  const selected = selectedAgentId;
  const rootItems = readQueueFor(void 0);
  if (rootItems.length > 0 || !selected) {
    groups.push({
      agentId: "",
      label: "General \xB7 shared",
      items: rootItems,
      connected: false,
      routing: !selected
    });
  }
  let sawSelected = false;
  for (const a of scanAllAgents()) {
    if (a.id === selected)
      sawSelected = true;
    groups.push({
      agentId: a.id,
      label: a.id.slice(0, 8),
      items: readQueueFor(a.id),
      connected: a.connected,
      routing: selected === a.id
    });
  }
  if (selected && !sawSelected) {
    groups.push({
      agentId: selected,
      label: selected.slice(0, 8),
      items: readQueueFor(selected),
      connected: false,
      routing: true
    });
  }
  return groups;
}
function pushAllQueues() {
  if (!mainPanel) {
    return;
  }
  const data = buildQueueGroups();
  const json = JSON.stringify(data);
  if (json === lastAllQueuesJson) {
    return;
  }
  lastAllQueuesJson = json;
  mainPanel.webview.postMessage({ type: "allQueues", data });
}
function getWorkspaceName() {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].name;
  }
  return "default";
}
function getWorkspacePath() {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return void 0;
}
function pushQuestionToRemoteNow(question) {
  if (!REMOTE_API_ENABLED) {
    return;
  }
  const card = readCardState();
  if (!card || !isCardValid()) {
    return;
  }
  const wsName = getWorkspaceName();
  if (question.id === lastRemoteQuestionId) {
    return;
  }
  lastRemoteQuestionId = question.id;
  pushRemoteQuestion(card.code, question.id, question.questions, wsName).catch(() => {
  });
}
function startRemotePolling() {
  return;
  if (remotePollTimer) {
    return;
  }
  const wsName = getWorkspaceName();
  const remotePoll = async () => {
    const card = readCardState();
    if (!card || !isCardValid()) {
      return;
    }
    try {
      const messages = await pollRemoteMessages(card.code, wsName);
      for (const msg of messages) {
        sendText(msg.content);
        resetIdleTimer();
        if (!chatTriggered) {
          triggerCursorChat();
        }
      }
    } catch {
    }
    const reply = readReply();
    if (reply && reply.content) {
      const replyKey = (reply.timestamp || "") + reply.content.slice(0, 50);
      if (replyKey !== lastReplyContent) {
        lastReplyContent = replyKey;
        resetIdleTimer();
        try {
          await pushRemoteReply(card.code, reply.content, wsName);
        } catch {
        }
      }
    } else {
      lastReplyContent = void 0;
    }
    const question = readQuestion();
    if (question && question.id !== lastRemoteQuestionId) {
      lastRemoteQuestionId = question.id;
      try {
        await pushRemoteQuestion(card.code, question.id, question.questions, wsName);
      } catch {
      }
    } else if (!question && lastRemoteQuestionId) {
      try {
        await cancelRemoteQuestion(card.code, lastRemoteQuestionId);
      } catch {
      }
      lastRemoteQuestionId = void 0;
    }
    if (question && lastRemoteQuestionId) {
      try {
        const result = await pollRemoteAnswer(card.code, lastRemoteQuestionId);
        if (result?.answered && result.answer) {
          writeAnswer(result.answer);
        }
      } catch {
      }
    }
  };
  remotePollTimer = setInterval(remotePoll, 3e3);
}
function startHeartbeat() {
  return;
  if (heartbeatTimer) {
    return;
  }
  const beat = async () => {
    const card = readCardState();
    if (!card || !isCardValid()) {
      return;
    }
    await sendWorkspaceHeartbeat(card.code, getWorkspaceName(), getWorkspacePath());
  };
  beat();
  heartbeatTimer = setInterval(beat, 15e3);
}
function autoSetupMcp(workspaceFolders = vscode.workspace.workspaceFolders || []) {
  const globalChanged = setupGlobalMcpConfig(currentDataDir);
  if (workspaceFolders.length === 0) {
    if (globalChanged) {
      vscode.window.showInformationMessage(
        "jefr MCP installed to global config. Restart Cursor to apply."
      );
    }
    return;
  }
  const changedCount = setupMcpForFolders(workspaceFolders);
  if (changedCount > 0 || globalChanged) {
    vscode.window.showInformationMessage(
      `jefr auto-installed config to ${changedCount} workspace(s). Restart Cursor to apply.`
    );
  }
}
async function triggerCursorChat() {
  return;
}
function setupMcpForFolders(workspaceFolders) {
  let changedCount = 0;
  for (const folder of workspaceFolders) {
    try {
      if (setupMcpConfig(folder.uri.fsPath, currentDataDir)) {
        changedCount++;
      }
    } catch (e) {
      vscode.window.showErrorMessage(
        `Failed to install MCP config: ${folder.name} - ${e.message}`
      );
    }
  }
  return changedCount;
}
var MessengerViewProvider = class {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
  }
  resolveWebviewView(webviewView) {
    mainPanel = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          this.pushCurrentState();
          this.pushCardState();
          mainPanel?.webview.postMessage({ type: "version", version: extensionVersion });
          mainPanel?.webview.postMessage({
            type: "injectedTokenState",
            injected: !!readInjectedToken()
          });
          this.pushQueueData();
          lastAgentListJson = void 0;
          pushAgentList();
          if (cdpEnabled) {
            getCdpMonitor().pollNow().then(() => {
              lastAgentListJson = void 0;
              pushAgentList();
            }).catch(() => {
            });
          }
          break;
        case "refreshAgents": {
          lastAgentListJson = void 0;
          if (cdpEnabled) {
            getCdpMonitor().pollNow().then(() => {
              lastAgentListJson = void 0;
              pushAgentList();
            }).catch(() => {
              pushAgentList();
            });
          } else {
            pushAgentList();
          }
          break;
        }
        case "closeDropped": {
          const n = await closeDroppedTiles();
          postWorkflow({
            type: "workflowOutput",
            stream: "stdout",
            line: n > 0 ? `[jefr] closed ${n} dropped tile${n !== 1 ? "s" : ""}` : "[jefr] no dropped tiles to close"
          });
          break;
        }
        case "selectAgent":
          selectAgent(msg.agentId);
          break;
        case "setAutoReconnect":
          autoReconnect = !!msg.enabled;
          lastAgentListJson = void 0;
          pushAgentList();
          break;
        case "reconnectAgent": {
          const aid = typeof msg.agentId === "string" ? msg.agentId : void 0;
          if (aid) {
            tileStateManager.markReconnectAttempt(aid);
            const s = agentStats.get(aid);
            if (s) {
              s.reconnectCount++;
              s.reconnectsSinceConnect++;
              s.lastReconnectAt = Date.now();
            }
            runWorkflow({ reconnect: true, agentId: aid });
          }
          break;
        }
        case "addAgent": {
          runWorkflow({
            model: typeof msg.model === "string" && msg.model.trim() || WORKFLOW_DEFAULT_MODEL,
            keepTiles: true
          });
          break;
        }
        case "addAgents": {
          const model = typeof msg.model === "string" && msg.model.trim() || WORKFLOW_DEFAULT_MODEL;
          const count = typeof msg.count === "number" && Number.isFinite(msg.count) && msg.count > 0 ? Math.floor(msg.count) : TARGET_AGENT_COUNT;
          queueAgentAdds(count, model);
          break;
        }
        case "deleteAgent": {
          const aid = typeof msg.agentId === "string" ? msg.agentId.trim() : "";
          if (!aid)
            break;
          if (isConnectingTarget(aid)) {
            dlog(`delete: ${aid.slice(0, 8)} is the connecting tile \u2014 stopping its workflow first`, "warn");
            postWorkflow({
              type: "workflowOutput",
              stream: "stdout",
              line: `[jefr] closing the connecting tile ${aid.slice(0, 8)} \u2014 stopping its spawn workflow`
            });
            stopWorkflow();
          }
          const tracked = tileStateManager.getAgent(aid);
          const tileIdx = tracked?.tileIndex ?? -1;
          const wasVisible = tileIdx >= 0;
          let closed = true;
          if (cdpEnabled && wasVisible) {
            if (aid.startsWith("tile:")) {
              closed = await getCdpMonitor().closeTileByIndex(tileIdx).catch(() => false);
            } else {
              closed = await getCdpMonitor().closeAgentTileFast(aid).catch(() => false);
              if (!closed) {
                closed = await getCdpMonitor().closeAgentTile(aid).catch(() => false);
              }
            }
          }
          if (!closed) {
            dlog(`delete: failed to close tile for ${aid.slice(0, 8)}`, "error");
            postWorkflow({
              type: "workflowOutput",
              stream: "stderr",
              line: `[jefr] Failed to close tile for agent ${aid.slice(0, 8)}; keeping it in the roster.`
            });
            lastAgentListJson = void 0;
            pushAgentList();
            break;
          }
          dlog(`deleted agent ${aid.slice(0, 8)} (tile closed)`);
          tileStateManager.forgetAgent(aid);
          agentStats.delete(aid);
          forgetAgentDir(aid);
          if (aid === selectedAgentId) {
            selectAgent(void 0);
          } else {
            lastAgentListJson = void 0;
            pushAgentList();
          }
          break;
        }
        case "focusAgent": {
          const aid = typeof msg.agentId === "string" ? msg.agentId.trim() : "";
          if (aid && cdpEnabled) {
            getCdpMonitor().focusAgent(aid).catch(() => {
            });
          }
          break;
        }
        case "sendText":
          if (!this.checkCard()) {
            return;
          }
          sendTextTo(selectedAgentId, msg.text);
          resetIdleTimer();
          triggerCursorChat();
          break;
        case "pickAttachment":
          if (!this.checkCard()) {
            return;
          }
          this.handlePickAttachment();
          break;
        case "sendImage":
          if (!this.checkCard()) {
            return;
          }
          this.handleSendImage(msg.caption);
          resetIdleTimer();
          break;
        case "sendPastedImage":
          if (!this.checkCard()) {
            return;
          }
          this.handlePastedImage(msg.dataUrl, msg.caption);
          resetIdleTimer();
          triggerCursorChat();
          break;
        case "sendFile":
          if (!this.checkCard()) {
            return;
          }
          this.handleSendFile();
          resetIdleTimer();
          break;
        case "resendFile":
          if (!this.checkCard()) {
            return;
          }
          if (msg.path) {
            sendFileTo(selectedAgentId, msg.path);
            resetIdleTimer();
            triggerCursorChat();
          }
          break;
        case "submitAnswer":
          writeAnswerFor(msg.data, selectedAgentId);
          break;
        case "cancelQuestion":
          cancelQuestionFor(selectedAgentId);
          break;
        case "ackReply":
          this.ackReply(msg.timestamp);
          break;
        case "activateCard":
          this.handleActivateCard(msg.code);
          break;
        case "logoutCard":
          clearCardState();
          this.pushCardState();
          break;
        case "getQueue":
          this.pushQueueData();
          break;
        case "deleteQueueItem":
          deleteQueueItemFor(msg.id, queueTarget(msg.agentId));
          this.pushQueueData();
          break;
        case "clearQueue":
          clearQueueFor(queueTarget(msg.agentId));
          this.pushQueueData();
          break;
        case "clearAllQueues":
          clearAllQueues();
          this.pushQueueData();
          break;
        case "updateQueueItem":
          updateQueueItemFor(msg.id, { content: msg.content }, queueTarget(msg.agentId));
          this.pushQueueData();
          break;
        case "fetchUsage":
          this.handleFetchUsage();
          break;
        case "injectToken":
          this.handleInjectToken(msg.token);
          break;
        case "clearInjectedToken":
          this.handleClearInjectedToken();
          break;
        case "openConsole":
          vscode.commands.executeCommand("mcpMessenger.openConsole");
          break;
        case "getServerInfo":
          mainPanel?.webview.postMessage({
            type: "serverInfo",
            data: { port: getServerPort(), clients: getConnectedClients() }
          });
          break;
        case "runWorkflow":
          try {
            runWorkflow({
              autoPrompt: msg.autoPrompt,
              opusPrompt: msg.opusPrompt,
              maxSecs: msg.maxSecs,
              enterInterval: msg.enterInterval,
              model: msg.model,
              // Default to keeping existing tiles so spawns accumulate agents;
              // the UI can pass keepTiles:false to force the clean-collapse spawn.
              keepTiles: msg.keepTiles !== false
            });
          } catch (e) {
            postWorkflow({
              type: "workflowOutput",
              stream: "stderr",
              line: `[jefr] runWorkflow failed: ${e.message}`
            });
            postWorkflow({ type: "workflowState", running: false });
            postWorkflow({ type: "workflowExit", code: null });
          }
          break;
        case "reconnectWorkflow":
          try {
            runWorkflow({
              reconnect: true,
              tile: typeof msg.tile === "number" && Number.isInteger(msg.tile) ? msg.tile : void 0,
              opusPrompt: msg.opusPrompt,
              maxSecs: msg.maxSecs,
              enterInterval: msg.enterInterval
            });
          } catch (e) {
            postWorkflow({
              type: "workflowOutput",
              stream: "stderr",
              line: `[jefr] reconnectWorkflow failed: ${e.message}`
            });
            postWorkflow({ type: "workflowState", running: false });
            postWorkflow({ type: "workflowExit", code: null });
          }
          break;
        case "stopWorkflow":
          stopWorkflow();
          break;
        case "getWorkflowState":
          postWorkflow({ type: "workflowState", running: !!workflowProc });
          break;
        case "getDebugLog":
          sendDebugLogSnapshot();
          break;
        case "clearDebugLog":
          debugLogBuf.length = 0;
          sendDebugLogSnapshot();
          break;
      }
    });
    webviewView.onDidDispose(() => {
      if (mainPanel === webviewView) {
        mainPanel = void 0;
        lastQuestionId = void 0;
        lastReplyTimestamp = void 0;
        lastQueueCount = void 0;
      }
    });
  }
  handlePastedImage(dataUrl, caption) {
    try {
      const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!match) {
        return;
      }
      const ext = match[1] === "jpeg" ? "jpg" : match[1];
      const buf = Buffer.from(match[2], "base64");
      const tmpPath = path3.join(os3.tmpdir(), "mcp_" + Date.now() + "." + ext);
      fs3.writeFileSync(tmpPath, buf);
      const item = sendImageTo(selectedAgentId, tmpPath, caption, dataUrl);
      appendSharedHistory({
        id: item.id,
        kind: "image",
        dataUrl,
        caption,
        name: path3.basename(tmpPath),
        path: tmpPath,
        timestamp: item.timestamp
      });
    } catch {
    }
  }
  async handlePickAttachment() {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: "Attach",
      filters: {
        Images: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"],
        Files: ["*"]
      }
    });
    if (!uris?.length) {
      return;
    }
    for (const uri of uris) {
      const name = path3.basename(uri.fsPath);
      const isImage = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(uri.fsPath);
      if (isImage) {
        let dataUrl = void 0;
        try {
          const buf = fs3.readFileSync(uri.fsPath);
          const ext = path3.extname(uri.fsPath).slice(1).toLowerCase() || "png";
          const mime = ext === "svg" ? "svg+xml" : ext === "jpg" ? "jpeg" : ext;
          dataUrl = `data:image/${mime};base64,${buf.toString("base64")}`;
        } catch {
        }
        mainPanel?.webview.postMessage({
          type: "attachmentAdded",
          item: { id: makeId(), type: "image", path: uri.fsPath, name, dataUrl }
        });
      } else {
        mainPanel?.webview.postMessage({
          type: "attachmentAdded",
          item: { id: makeId(), type: "file", path: uri.fsPath, name }
        });
      }
    }
  }
  async handleSendImage(caption) {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { Images: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] }
    });
    if (uris?.[0]) {
      sendImageTo(selectedAgentId, uris[0].fsPath, caption);
    }
  }
  async handleSendFile() {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: false });
    if (uris?.[0]) {
      sendFileTo(selectedAgentId, uris[0].fsPath);
    }
  }
  pushCurrentState() {
    if (!mainPanel) {
      return;
    }
    const question = readQuestionFor(selectedAgentId);
    if (question) {
      mainPanel.webview.postMessage({ type: "showQuestion", data: question });
      lastQuestionId = question.id;
    } else {
      mainPanel.webview.postMessage({ type: "clearQuestion" });
      lastQuestionId = void 0;
    }
    const reply = readReplyFor(selectedAgentId);
    if (reply) {
      mainPanel.webview.postMessage({ type: "showReply", data: reply });
      lastReplyTimestamp = reply.timestamp;
    } else {
      lastReplyTimestamp = void 0;
    }
    const count = getQueueCountFor(selectedAgentId);
    mainPanel.webview.postMessage({ type: "queueCount", count });
    lastQueueCount = count;
  }
  checkCard() {
    return true;
  }
  pushQueueData() {
    if (!mainPanel) {
      return;
    }
    mainPanel.webview.postMessage({ type: "queueData", data: readQueueFor(selectedAgentId) });
    pushAllQueues();
  }
  pushCardState() {
    if (!mainPanel) {
      return;
    }
    mainPanel.webview.postMessage({ type: "cardState", data: { active: true } });
  }
  async handleActivateCard(code) {
    if (!mainPanel || !code) {
      return;
    }
    try {
      const result = await activateCard(code);
      if (result.success) {
        mainPanel.webview.postMessage({ type: "cardActivated", data: result.data });
        vscode.window.showInformationMessage(
          `License activated successfully. Valid for ${result.data?.duration_hours} hours`
        );
      } else {
        mainPanel.webview.postMessage({
          type: "cardError",
          error: result.error || "Activation failed"
        });
      }
    } catch (e) {
      mainPanel.webview.postMessage({
        type: "cardError",
        error: e.message || "Network error"
      });
    }
  }
  async handleFetchUsage() {
    if (!mainPanel) {
      return;
    }
    mainPanel.webview.postMessage({ type: "usageLoading" });
    try {
      const result = await fetchCursorUsage();
      mainPanel.webview.postMessage({ type: "usageData", data: result });
    } catch (e) {
      mainPanel.webview.postMessage({
        type: "usageData",
        data: { success: false, error: e.message || "Query failed" }
      });
    }
  }
  async handleInjectToken(token) {
    if (!mainPanel || !token) {
      return;
    }
    writeInjectedToken(token.trim());
    mainPanel.webview.postMessage({ type: "injectedTokenState", injected: true });
    this.handleFetchUsage();
  }
  handleClearInjectedToken() {
    if (!mainPanel) {
      return;
    }
    clearInjectedToken();
    mainPanel.webview.postMessage({ type: "injectedTokenState", injected: false });
    this.handleFetchUsage();
  }
  async ackReply(timestamp) {
    const reply = readReplyFor(selectedAgentId);
    if (!reply) {
      lastReplyTimestamp = void 0;
      return;
    }
    if (!timestamp || reply.timestamp === timestamp) {
      if (REMOTE_API_ENABLED) {
        const card = readCardState();
        if (card && isCardValid() && reply.content) {
          const replyKey = (reply.timestamp || "") + reply.content.slice(0, 50);
          if (replyKey !== lastReplyContent) {
            lastReplyContent = replyKey;
            try {
              await pushRemoteReply(card.code, reply.content, getWorkspaceName());
            } catch {
            }
          }
        }
      }
      appendReplyToSharedHistory(reply);
      clearReplyFor(selectedAgentId);
      lastReplyTimestamp = void 0;
    }
  }
  getHtml(webview) {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.css")
    );
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta
		http-equiv="Content-Security-Policy"
		content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
	>
	<link rel="stylesheet" href="${styleUri}">
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
	<script nonce="${nonce}">
	(function(){
		const vscode = acquireVsCodeApi();

		/* \u2500\u2500 Drag & Drop \u2500\u2500 */
		var dragRetry = 0;
		function setupDragDrop(){
			var area = document.querySelector('.input-area');
			if(!area){ if(dragRetry++<30) setTimeout(setupDragDrop,500); return; }
			var dragCount = 0;
			area.addEventListener('dragenter', function(e){ e.preventDefault(); e.stopPropagation(); dragCount++; area.classList.add('drag-over'); });
			area.addEventListener('dragleave', function(e){ e.preventDefault(); e.stopPropagation(); dragCount--; if(dragCount<=0){dragCount=0;area.classList.remove('drag-over');} });
			area.addEventListener('dragover', function(e){ e.preventDefault(); e.stopPropagation(); });
			area.addEventListener('drop', function(e){
				e.preventDefault(); e.stopPropagation(); dragCount=0; area.classList.remove('drag-over');
				var files = e.dataTransfer && e.dataTransfer.files;
				if(!files||!files.length) return;
				Array.from(files).forEach(function(file){
					if(file.type && file.type.startsWith('image/')){
						var r = new FileReader(); r.onload=function(ev){ vscode.postMessage({type:'sendPastedImage',dataUrl:ev.target.result,caption:''}); }; r.readAsDataURL(file);
					} else {
						var r2 = new FileReader(); r2.onload=function(ev){ var c=ev.target.result; var p=c.length>500?c.slice(0,500)+'...':c; vscode.postMessage({type:'sendText',text:'[File: '+file.name+']\\n'+p}); }; r2.readAsText(file);
					}
				});
			});
		}


		/* \u2500\u2500 Font zoom (Ctrl/Cmd +/-/0 and Ctrl+wheel) \u2500\u2500 */
		var ZOOM_KEY = 'jefr.zoom';
		var ZOOM_MIN = 0.5, ZOOM_MAX = 3, ZOOM_STEP = 0.1;
		function getZoom(){
			var z = parseFloat(localStorage.getItem(ZOOM_KEY));
			return (isFinite(z) && z > 0) ? z : 1;
		}
		function applyZoom(z){
			z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z*100)/100));
			document.body.style.zoom = z;
			try { localStorage.setItem(ZOOM_KEY, String(z)); } catch(e){}
			return z;
		}
		function setupZoom(){
			applyZoom(getZoom());
			window.addEventListener('keydown', function(e){
				if(!(e.ctrlKey || e.metaKey)) return;
				var k = e.key;
				if(k === '+' || k === '=' ){ e.preventDefault(); applyZoom(getZoom()+ZOOM_STEP); }
				else if(k === '-' || k === '_'){ e.preventDefault(); applyZoom(getZoom()-ZOOM_STEP); }
				else if(k === '0'){ e.preventDefault(); applyZoom(1); }
			}, true);
			window.addEventListener('wheel', function(e){
				if(!(e.ctrlKey || e.metaKey)) return;
				e.preventDefault();
				applyZoom(getZoom() + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
			}, { passive: false, capture: true });
		}

		/* \u2500\u2500 Enhanced history (placeholder) \u2500\u2500 */
		function enhanceHistory(){}

		/* \u2500\u2500 Tutorial \u2500\u2500 */
		var tRetry = 0;
		function setupTutorial(){
			var app = document.querySelector('.app');
			if(!app){ if(tRetry++<30) setTimeout(setupTutorial,500); return; }
			if(app.querySelector('.tutorial-section')) return;
			var section = document.createElement('div');
			section.className = 'tutorial-section';
			var btn = document.createElement('button');
			btn.className = 'tutorial-btn';
			btn.innerHTML = '\\u{1F4D6} Tutorial';
			var body = document.createElement('div');
			body.className = 'tutorial-body';
			var steps = [
				['Install','Install jefr from VSIX, then restart Cursor'],
				['Check MCP','Cursor Settings \\u2192 Tools & MCP \\u2192 enable jefr'],
				['Start chat','Send a message in the bottom panel; AI replies in the loop']
			];
			var html='';
			for(var i=0;i<steps.length;i++){
				html+='<div class="tutorial-step"><span class="step-num">'+(i+1)+'</span><div class="step-content"><div class="step-title">'+steps[i][0]+'</div><div class="step-desc">'+steps[i][1]+'</div></div></div>';
			}
			body.innerHTML=html;
			section.appendChild(btn);
			section.appendChild(body);
			app.appendChild(section);
			btn.addEventListener('click',function(){ body.classList.toggle('show'); });
		}

		/* \u2500\u2500 Init \u2500\u2500 */
		function init(){ setupZoom(); setupDragDrop(); enhanceHistory(); setupTutorial(); }
		if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded', init); }
		else { init(); }
	})();
	</script>
</body>
</html>`;
  }
};
function getNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
