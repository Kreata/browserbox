(function(root, factory) {
    'use strict';

    if (typeof define === 'function' && define.amd) {
        define(['tcp-socket', 'imap-handler', 'mimefuncs', 'browserbox-compression'], function(TCPSocket, imapHandler, mimefuncs, compression) {
            return factory(TCPSocket, imapHandler, mimefuncs, compression);
        });
    } else if (typeof exports === 'object') {
        module.exports = factory(require('tcp-socket'), require('wo-imap-handler'), require('mimefuncs'), require('./browserbox-compression'), null);
    } else {
        root.BrowserboxImapClient = factory(navigator.TCPSocket, root.imapHandler, root.mimefuncs, root.BrowserboxCompressor);
    }
}(this, function(TCPSocket, imapHandler, mimefuncs, Compression) {
    'use strict';

    //
    // constants used for communication with the worker
    //
    var MESSAGE_START = 'start';
    var MESSAGE_INFLATE = 'inflate';
    var MESSAGE_INFLATED_DATA_READY = 'inflated_ready';
    var MESSAGE_DEFLATE = 'deflate';
    var MESSAGE_DEFLATED_DATA_READY = 'deflated_ready';

    var COMMAND_REGEX = /(\{(\d+)(\+)?\})?\r?\n/;
    var EOL = '\r\n';

    /**
     * Creates a connection object to an IMAP server. Call `connect` method to inititate
     * the actual connection, the constructor only defines the properties but does not actually connect.
     *
     * @constructor
     *
     * @param {String} [host='localhost'] Hostname to conenct to
     * @param {Number} [port=143] Port number to connect to
     * @param {Object} [options] Optional options object
     * @param {String} [options.compressionWorkerPath] offloads de-/compression computation to a web worker, this is the path to the browserified browserbox-compressor-worker.js
     * @params {Object} [options.tcpSocket] Optional options to pass to the TCPsocket connection, see: https://github.com/whiteout-io/tcp-socket for details.
     * @params {Boolean} [options.tcpSocket.useSecureTransport] Set to true, to use encrypted connection
     * @params {Boolean} [options.tcpSocket.ca] specify a CA certificate for validating keys.
     * @params {Boolean} [options.tcpSocket.tlsWorkerPath] Specify a TLS Worker Path to offload TLS processing in the browser to a service worker.
     * @params {Object} [options.tcpSocket.ws] Optional options to pass to the socket.io connection when TCPSocket is shimmed with a websocket.
     */
    function ImapClient(host, port, options) {
        this._TCPSocket = TCPSocket;

        this.options = options || {};
        this.options.tcpSocket = this.options.tcpSocket || { useSecureTransport: true, binaryType: 'arraybuffer' };

        this.port = port || (this.options.tcpSocket.useSecureTransport ? 993 : 143);
        this.host = host || 'localhost';


        // Use a TLS connection. Port 993 also forces TLS.
        this.options.tcpSocket.useSecureTransport = 'useSecureTransport' in this.options.tcpSocket ? !!this.options.tcpSocket.useSecureTransport : this.port === 993;

        this.secureMode = !!this.options.useSecureTransport; // Does the connection use SSL/TLS

        this._connectionReady = false; // Is the conection established and greeting is received from the server

        this._globalAcceptUntagged = {}; // Global handlers for unrelated responses (EXPUNGE, EXISTS etc.)

        this._clientQueue = []; // Queue of outgoing commands
        this._canSend = false; // Is it OK to send something to the server
        this._tagCounter = 0; // Counter to allow uniqueue imap tags
        this._currentCommand = false; // Current command that is waiting for response from the server

        this._idleTimer = false; // Timer waiting to enter idle
        this._socketTimeoutTimer = false; // Timer waiting to declare the socket dead starting from the last write

        this.compressed = false; // Is the connection compressed and needs inflating/deflating
        this._workerPath = this.options.compressionWorkerPath; // The path for the compressor's worker script
        this._compression = new Compression();

        //
        // HELPERS
        //

        // As the server sends data in chunks, it needs to be split into separate lines. Helps parsing the input.
        this._incomingBuffer = '';
        this._command = '';
        this._literalRemaining = 0;

        //
        // Event placeholders, should be overriden
        //
        this.onerror = () => {}; // Irrecoverable error occurred. Connection to the server will be closed automatically.
        this.onready = () => {}; // The connection to the server has been established and greeting is received
        this.onidle = () => {}; // There are no more commands to process
    }

    // Constants

    /**
     * How much time to wait since the last response until the connection is considered idling
     */
    ImapClient.prototype.TIMEOUT_ENTER_IDLE = 1000;

    /**
     * Lower Bound for socket timeout to wait since the last data was written to a socket
     */
    ImapClient.prototype.TIMEOUT_SOCKET_LOWER_BOUND = 10000;

    /**
     * Multiplier for socket timeout:
     *
     * We assume at least a GPRS connection with 115 kb/s = 14,375 kB/s tops, so 10 KB/s to be on
     * the safe side. We can timeout after a lower bound of 10s + (n KB / 10 KB/s). A 1 MB message
     * upload would be 110 seconds to wait for the timeout. 10 KB/s === 0.1 s/B
     */
    ImapClient.prototype.TIMEOUT_SOCKET_MULTIPLIER = 0.1;

    // PUBLIC METHODS

    /**
     * Initiate a connection to the server. Wait for onready event
     */
    ImapClient.prototype.connect = function() {
        return new Promise((resolve, reject) => {
            this.socket = this._TCPSocket.open(this.host, this.port, this.options.tcpSocket);

            // allows certificate handling for platform w/o native tls support
            // oncert is non standard so setting it might throw if the socket object is immutable
            try {
                this.socket.oncert = this.oncert;
            } catch (E) {}

            // Connection closing unexpected is an error
            this.socket.onclose = () => this._onError(new Error('Socket closed unexceptedly!'));
            this.socket.ondata = (evt) => this._onData(evt);

            // if an error happens during create time, reject the promise
            this.socket.onerror = (e) => {
                reject(new Error('Could not open socket: ' + e.data.message));
            };

            this.socket.onopen = () => {
                // use proper "irrecoverable error, tear down everything"-handler only after socket is open
                this.socket.onerror = (e) => this._onError(e);
                resolve();
            };
        });
    };

    /**
     * Closes the connection to the server
     */
    ImapClient.prototype.close = function() {
        return new Promise((resolve) => {
            var tearDown = () => {
                this._clientQueue = [];
                this._currentCommand = false;
                clearTimeout(this._idleTimer);
                clearTimeout(this._socketTimeoutTimer);

                if (this.socket) {
                    // remove all listeners
                    this.socket.onclose = () => {};
                    this.socket.ondata = () => {};
                    this.socket.ondrain = () => {};
                    this.socket.onerror = () => {};
                }

                resolve();
            };

            this._disableCompression();

            if (!this.socket || this.socket.readyState !== 'open') {
                return tearDown();
            }

            this.socket.onclose = this.socket.onerror = tearDown; // we don't really care about the error here
            this.socket.close();
        });
    };

    ImapClient.prototype.logout = function() {
        return new Promise((resolve, reject) => {
            this.socket.onclose = this.socket.onerror = () => {
                this.close().then(resolve).catch(reject);
            };

            this.enqueueCommand('LOGOUT');
        });
    };

    /**
     * Closes the connection to the server
     */
    ImapClient.prototype.upgrade = function() {
        this.secureMode = true;
        this.socket.upgradeToSecure();
    };

    /**
     * Schedules a command to be sent to the server. This method is chainable.
     * See https://github.com/Kreata/imapHandler for request structure.
     * Do not provide a tag property, it will be set byt the queue manager.
     *
     * To catch untagged responses use acceptUntagged property. For example, if
     * the value for it is 'FETCH' then the reponse includes 'payload.FETCH' property
     * that is an array including all listed * FETCH responses.
     *
     * @param {Object} request Structured request object
     * @param {Array} acceptUntagged a list of untagged responses that will be included in 'payload' property
     * @param {Object} [options] Optional data for the command payload
     * @returns {Promise} Promise that resolves when the request is done
     */
    ImapClient.prototype.enqueueCommand = function(request, acceptUntagged, options) {
        if (typeof request === 'string') {
            request = {
                command: request
            };
        }

        acceptUntagged = [].concat(acceptUntagged || []).map((untagged) => (untagged || '').toString().toUpperCase().trim());

        var tag = 'W' + (++this._tagCounter);
        request.tag = tag;

        return new Promise((resolve, reject) => {
            var data = {
                tag: tag,
                request: request,
                payload: acceptUntagged.length ? {} : undefined,
                callback: (response) => {
                    if (this.isError(response)) {
                        return reject(response);
                    } else if (['NO', 'BAD'].indexOf((response && response.command || '').toString().toUpperCase().trim()) >= 0) {
                        var error = new Error(response.humanReadable || 'Error');
                        if (response.code) {
                            error.code = response.code;
                        }
                        return reject(error);
                    }

                    resolve(response);
                }
            };

            // apply any additional options to the command
            Object.keys(options || {}).forEach((key) => data[key] = options[key]);

            acceptUntagged.forEach((command) => data.payload[command] = []);

            // if we're in priority mode (i.e. we ran commands in a precheck),
            // queue any commands BEFORE the command that contianed the precheck,
            // otherwise just queue command as usual
            var index = data.ctx ? this._clientQueue.indexOf(data.ctx) : -1;
            if (index >= 0) {
                data.tag += '.p';
                data.request.tag += '.p';
                this._clientQueue.splice(index, 0, data);
            } else {
                this._clientQueue.push(data);
            }

            if (this._canSend) {
                this._sendRequest();
            }
        });
    };

    /**
     * Send data to the TCP socket
     * Arms a timeout waiting for a response from the server.
     *
     * @param {String} str Payload
     */
    ImapClient.prototype.send = function(str) {
        var buffer = mimefuncs.toTypedArray(str).buffer,
            timeout = this.TIMEOUT_SOCKET_LOWER_BOUND + Math.floor(buffer.byteLength * this.TIMEOUT_SOCKET_MULTIPLIER);

        clearTimeout(this._socketTimeoutTimer); // clear pending timeouts
        this._socketTimeoutTimer = setTimeout(() => this._onError(new Error(this.options.sessionId + ' Socket timed out!')), timeout); // arm the next timeout

        if (this.compressed) {
            this._sendCompressed(buffer);
        } else {
            this.socket.send(buffer);
        }
    };

    /**
     * Set a global handler for an untagged response. If currently processed command
     * has not listed untagged command it is forwarded to the global handler. Useful
     * with EXPUNGE, EXISTS etc.
     *
     * @param {String} command Untagged command name
     * @param {Function} callback Callback function with response object and continue callback function
     */
    ImapClient.prototype.setHandler = function(command, callback) {
        this._globalAcceptUntagged[command.toUpperCase().trim()] = callback;
    };

    // INTERNAL EVENTS

    /**
     * Error handler for the socket
     *
     * @event
     * @param {Event} evt Event object. See evt.data for the error
     */
    ImapClient.prototype._onError = function(evt) {
        this.close().then(() => {
            if (this.isError(evt)) {
                this.onerror(evt);
            } else if (evt && this.isError(evt.data)) {
                this.onerror(evt.data);
            } else {
                this.onerror(new Error(evt && evt.data && evt.data.message || evt.data || evt || 'Error'));
            }
        });
    };

    /**
     * Handler for incoming data from the server. The data is sent in arbitrary
     * chunks and can't be used directly so this function makes sure the data
     * is split into complete lines before the data is passed to the command
     * handler
     *
     * @param {Event} evt
     */
    ImapClient.prototype._onData = function(evt) {
        clearTimeout(this._socketTimeoutTimer); // clear the timeout, the socket is still up
        this._incomingBuffer += mimefuncs.fromTypedArray(evt.data); // append to the incoming buffer
        this._parseIncomingCommands(this._iterateIncomingBuffer());
    };

    ImapClient.prototype._iterateIncomingBuffer = function* () {
        var match;
        // The input is interesting as long as there are complete lines
        while ((match = this._incomingBuffer.match(COMMAND_REGEX))) {
            if (this._literalRemaining && this._literalRemaining > this._incomingBuffer.length) {
                // we're expecting more incoming literal data than available, wait for the next chunk
                return;
            }

            if (this._literalRemaining) {
                // we're expecting incoming literal data:
                // take portion of pending literal data from the chunk, parse the remaining buffer in the next iteration
                this._command += this._incomingBuffer.substr(0, this._literalRemaining);
                this._incomingBuffer = this._incomingBuffer.substr(this._literalRemaining);
                this._literalRemaining = 0;
                continue;
            }

            if (match[2]) {
                // we have a literal data command:
                // take command portion (match.index) including the literal data octet count (match[0].length)
                // from the chunk, parse the literal data in the next iteration
                this._literalRemaining = Number(match[2]);
                this._command += this._incomingBuffer.substr(0, match.index + match[0].length);
                this._incomingBuffer = this._incomingBuffer.substr(match.index + match[0].length);
                continue;
            }

            // we have a complete command, pass on to processing
            this._command += this._incomingBuffer.substr(0, match.index);
            this._incomingBuffer = this._incomingBuffer.substr(match.index + match[0].length);
            yield this._command;

            this._command = ''; // clear for next iteration
        }
    };



    // PRIVATE METHODS

    /**
     * Process a command from the queue. The command is parsed and feeded to a handler
     */
    ImapClient.prototype._parseIncomingCommands = function(commands) {
        for (var command of commands) {
            this._clearIdle(); // TODO the way idle is handled is highly questionable

            /*
             * The "+"-tagged response is a special case:
             * Either the server can asks for the next chunk of data, e.g. for the AUTHENTICATE command.
             *
             * Or there was an error in the XOAUTH2 authentication, for which SASL initial client response extension
             * dictates the client sends an empty EOL response to the challenge containing the error message.
             *
             * Details on "+"-tagged response:
             *   https://tools.ietf.org/html/rfc3501#section-2.2.1
             */
            //
            if (/^\+/.test(command)) {
                if (this._currentCommand.data.length) {
                    // feed the next chunk of data
                    var chunk = this._currentCommand.data.shift();
                    chunk += (!this._currentCommand.data.length ? EOL : ''); // EOL if there's nothing more to send
                    this.send(chunk);
                } else if (typeof this._currentCommand.errorResponseExpectsEmptyLine) {
                    this.send(EOL); // XOAUTH2 empty response, error will be reported when server continues with NO response
                }
                continue;
            }

            var response;
            try {
                response = imapHandler.parser(command);
                // console.log(this.options.sessionId + ' S: ' + imapHandler.compiler(response, false, true));
            } catch (e) {
                console.error(this.options.sessionId + ' error parsing imap response: ' + e + '\n' + e.stack + '\nraw:' + command);
                return this._onError(e);
            }

            this._processResponse(response);
            this._handleResponse(response);

            // first response from the server, connection is now usable
            if (!this._connectionReady) {
                this._connectionReady = true;
                this.onready();
            }
        }
    };

    /**
     * Feeds a parsed response object to an appropriate handler
     *
     * @param {Object} response Parsed command object
     */
    ImapClient.prototype._handleResponse = function(response) {
        var command = (response && response.command || '').toUpperCase().trim();

        if (!this._currentCommand) {
            // unsolicited untagged response
            if (response.tag === '*' && command in this._globalAcceptUntagged) {
                this._globalAcceptUntagged[command](response);
                this._canSend = true;
                this._sendRequest();
            }
        } else if (this._currentCommand.payload && response.tag === '*' && command in this._currentCommand.payload) {
            // expected untagged response
            this._currentCommand.payload[command].push(response);
        } else if (response.tag === '*' && command in this._globalAcceptUntagged) {
            // unexpected untagged response
            this._globalAcceptUntagged[command](response);
            this._canSend = true;
            this._sendRequest();
        } else if (response.tag === this._currentCommand.tag) {
            // tagged response
            if (this._currentCommand.payload && Object.keys(this._currentCommand.payload).length) {
                response.payload = this._currentCommand.payload;
            }
            this._currentCommand.callback(response);
            this._canSend = true;
            this._sendRequest();
        }
    };

    /**
     * Sends a command from client queue to the server.
     */
    ImapClient.prototype._sendRequest = function() {
        if (!this._clientQueue.length) {
            return this._enterIdle();
        }
        this._clearIdle();

        // an operation was made in the precheck, no need to restart the queue manually
        this._restartQueue = false;

        var command = this._clientQueue[0];
        if (typeof command.precheck === 'function') {
            // remember the context
            var context = command;
            var precheck = context.precheck;
            delete context.precheck;

            // we need to restart the queue handling if no operation was made in the precheck
            this._restartQueue = true;

            // invoke the precheck command and resume normal operation after the promise resolves
            precheck(context).then(() => {
                // we're done with the precheck
                if (this._restartQueue) {
                    // we need to restart the queue handling
                    this._sendRequest();
                }
            }).catch((err) => {
                // precheck callback failed, so we remove the initial command
                // from the queue, invoke its callback and resume normal operation
                var cmd, index = this._clientQueue.indexOf(context);
                if (index >= 0) {
                    cmd = this._clientQueue.splice(index, 1)[0];
                }
                if (cmd && cmd.callback) {
                    cmd.callback(err, () => {
                        this._canSend = true;
                        this._sendRequest();
                        setTimeout(() => this._processServerQueue(), 0);
                    });
                }
            });
            return;
        }

        this._canSend = false;
        this._currentCommand = this._clientQueue.shift();
        var loggedCommand = false;

        try {
            this._currentCommand.data = imapHandler.compiler(this._currentCommand.request, true);
            loggedCommand = imapHandler.compiler(this._currentCommand.request, false, true);
        } catch (e) {
            console.error(this.options.sessionId + ' error compiling imap command: ' + e + '\nstack trace: ' + e.stack + '\nraw:' + this._currentCommand.request);
            return this._onError(e);
        }

        // console.log(this.options.sessionId + ' C: ' + loggedCommand);
        var data = this._currentCommand.data.shift();

        this.send(data + (!this._currentCommand.data.length ? EOL : ''));
        return this.waitDrain;
    };

    /**
     * Emits onidle, noting to do currently
     */
    ImapClient.prototype._enterIdle = function() {
        clearTimeout(this._idleTimer);
        this._idleTimer = setTimeout(() => this.onidle(), this.TIMEOUT_ENTER_IDLE);
    };

    /**
     * Cancel idle timer
     */
    ImapClient.prototype._clearIdle = function() {
        clearTimeout(this._idleTimer);
    };

    /**
     * Method processes a response into an easier to handle format.
     * Add untagged numbered responses (e.g. FETCH) into a nicely feasible form
     * Checks if a response includes optional response codes
     * and copies these into separate properties. For example the
     * following response includes a capability listing and a human
     * readable message:
     *
     *     * OK [CAPABILITY ID NAMESPACE] All ready
     *
     * This method adds a 'capability' property with an array value ['ID', 'NAMESPACE']
     * to the response object. Additionally 'All ready' is added as 'humanReadable' property.
     *
     * See possiblem IMAP Response Codes at https://tools.ietf.org/html/rfc5530
     *
     * @param {Object} response Parsed response object
     */
    ImapClient.prototype._processResponse = function(response) {
        var command = (response && response.command || '').toString().toUpperCase().trim(),
            option,
            key;

        // no attributes
        if (!response || !response.attributes || !response.attributes.length) {
            return;
        }

        // untagged responses w/ sequence numbers
        if (response.tag === '*' && /^\d+$/.test(response.command) && response.attributes[0].type === 'ATOM') {
            response.nr = Number(response.command);
            response.command = (response.attributes.shift().value || '').toString().toUpperCase().trim();
        }

        // no optional response code
        if (['OK', 'NO', 'BAD', 'BYE', 'PREAUTH'].indexOf(command) < 0) {
            return;
        }

        // If last element of the response is TEXT then this is for humans
        if (response.attributes[response.attributes.length - 1].type === 'TEXT') {
            response.humanReadable = response.attributes[response.attributes.length - 1].value;
        }

        // Parse and format ATOM values
        if (response.attributes[0].type === 'ATOM' && response.attributes[0].section) {
            option = response.attributes[0].section.map((key) => {
                if (!key) {
                    return;
                }
                if (Array.isArray(key)) {
                    return key.map((key) => (key.value || '').toString().trim());
                } else {
                    return (key.value || '').toString().toUpperCase().trim();
                }
            });

            key = option.shift();
            response.code = key;

            if (option.length === 1) {
                response[key.toLowerCase()] = option[0];
            } else if (option.length > 1) {
                response[key.toLowerCase()] = option;
            }
        }
    };

    /**
     * Checks if a value is an Error object
     *
     * @param {Mixed} value Value to be checked
     * @return {Boolean} returns true if the value is an Error
     */
    ImapClient.prototype.isError = function(value) {
        return !!Object.prototype.toString.call(value).match(/Error\]$/);
    };

    // COMPRESSION RELATED METHODS

    /**
     * Sets up deflate/inflate for the IO
     */
    ImapClient.prototype.enableCompression = function() {
        this._socketOnData = this.socket.ondata;
        this.compressed = true;

        if (typeof window !== 'undefined' && window.Worker && typeof this._workerPath === 'string') {

            //
            // web worker support
            //

            this._compressionWorker = new Worker(this._workerPath);
            this._compressionWorker.onmessage = (e) => {
                var message = e.data.message,
                    buffer = e.data.buffer;

                switch (message) {
                    case MESSAGE_INFLATED_DATA_READY:
                        this._socketOnData({
                            data: buffer
                        });
                        break;

                    case MESSAGE_DEFLATED_DATA_READY:
                        this.waitDrain = this.socket.send(buffer);
                        break;

                }
            };

            this._compressionWorker.onerror = (e) => {
                var error = new Error('Error handling compression web worker: Line ' + e.lineno + ' in ' + e.filename + ': ' + e.message);
                console.error(error);
                this._onError(error);
            };

            // first message starts the worker
            this._compressionWorker.postMessage(this._createMessage(MESSAGE_START));

        } else {

            //
            // without web worker support
            //

            this._compression.inflatedReady = (buffer) => {
                // emit inflated data
                this._socketOnData({
                    data: buffer
                });
            };

            this._compression.deflatedReady = (buffer) => {
                // write deflated data to socket
                if (!this.compressed) {
                    return;
                }

                this.waitDrain = this.socket.send(buffer);
            };
        }

        // override data handler, decompress incoming data
        this.socket.ondata = (evt) => {
            if (!this.compressed) {
                return;
            }

            // inflate
            if (this._compressionWorker) {
                this._compressionWorker.postMessage(this._createMessage(MESSAGE_INFLATE, evt.data), [evt.data]);
            } else {
                this._compression.inflate(evt.data);
            }
        };
    };



    /**
     * Undoes any changes related to compression. This only be called when closing the connection
     */
    ImapClient.prototype._disableCompression = function() {
        if (!this.compressed) {
            return;
        }

        this.compressed = false;
        this.socket.ondata = this._socketOnData;
        this._socketOnData = null;

        if (this._compressionWorker) {
            // terminate the worker
            this._compressionWorker.terminate();
            this._compressionWorker = null;
        }
    };

    /**
     * Outgoing payload needs to be compressed and sent to socket
     *
     * @param {ArrayBuffer} buffer Outgoing uncompressed arraybuffer
     */
    ImapClient.prototype._sendCompressed = function(buffer) {
        // deflate
        if (this._compressionWorker) {
            this._compressionWorker.postMessage(this._createMessage(MESSAGE_DEFLATE, buffer), [buffer]);
        } else {
            this._compression.deflate(buffer);
        }
    };

    ImapClient.prototype._createMessage = function(message, buffer) {
        return {
            message: message,
            buffer: buffer
        };
    };


    return ImapClient;
}));
