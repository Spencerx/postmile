/*
* Copyright (c) 2011 Yahoo! Inc. All rights reserved. Copyrights licensed under the New BSD License.
* See LICENSE file included with this code project for license terms.
*/

// Load modules

var Http = require('http');
var MAC = require('mac');
var Utils = require('./utils');
var Err = require('./error');


// Declare internals

var internals = {

    // API settings

    apiHost: 'api.sled.com',
    apiPort: 80
};


// Type definition

exports.type = {

    get: { type: 'string', array: true, required: true }
};


// Batch processing

exports.post = function (req, res, next) {

    var requests = [];
    var results = [];
    var resultsMap = {};

    function entry() {

        var requestRegex = /(?:\/)(?:\$(\d)+\.)?([\w:\.]+)/g;       // /sled/$1.sled/tasks, does not allow using array responses

        // Validate requests

        var error = null;
        var parseRequest = function ($0, $1, $2) {

            if ($1) {

                if ($1 < i) {

                    if ($1.indexOf(':') === -1) {

                        parts.push({ type: 'ref', index: $1, value: $2 });
                        return '';
                    }
                    else {

                        error = 'Request reference includes invalid ":" character (' + i + ')';
                        return $0;
                    }
                }
                else {

                    error = 'Request reference is beyond array size (' + i + ')';
                    return $0;
                }
            }
            else {

                parts.push({ type: 'text', value: $2 });
                return '';
            }
        };

        for (var i = 0, il = req.body.get.length; i < il; ++i) {

            // Break into parts

            var parts = [];
            var result = req.body.get[i].replace(requestRegex, parseRequest);

            // Make sure entire string was processed (empty)

            if (result === '') {

                requests.push(parts);
            }
            else {

                error = error || 'Invalid request format (' + i + ')';
                break;
            }
        }

        if (error === null) {

            process();
        }
        else {

            res.api.error = Err.badRequest(error);
            next();
        }
    }

    function process() {

        batch(0, function () {

            // Return results

            res.api.result = results;
            next();
        });
    }

    function batch(pos, callback) {

        if (pos >= requests.length) {

            callback();
        }
        else {

            // Prepare request

            var parts = requests[pos];
            var path = '';
            var error = null;

            for (var i = 0, il = parts.length; i < il; ++i) {

                path += '/';

                if (parts[i].type === 'ref') {

                    var ref = resultsMap[parts[i].index];
                    if (ref) {

                        var value = null;

                        try {

                            eval('value = ref.' + parts[i].value + ';');
                        }
                        catch (e) {

                            error = e.message;
                        }

                        if (value) {

                            if (value.match(/^[\w:]+$/)) {

                                path += value;
                            }
                            else {

                                error = 'Reference value includes illegal characters';
                                break;
                            }
                        }
                        else {

                            error = error || 'Reference not found';
                            break;
                        }
                    }
                    else {

                        error = 'Missing reference response';
                        break;
                    }
                }
                else {

                    path += parts[i].value;
                }
            }

            if (error === null) {

                // Make request

                internals.call('GET', path, null, req.api.session, function (data, err) {

                    if (err === null) {

                        // Process response

                        results.push(data);
                        resultsMap[pos] = data;
                    }
                    else {

                        results.push(err);
                    }

                    // Call next

                    batch(pos + 1, callback);
                });
            }
            else {

                // Set error response (as string)

                results.push(error);

                // Call next

                batch(pos + 1, callback);
            }
        }
    }

    entry();
};


// Make API call

internals.call = function (method, path, content, arg1, arg2) {   // session, callback

    var callback = arg2 || arg1;
    var session = (arg2 ? arg1 : null);
    var body = content !== null ? JSON.stringify(content) : null;

    var authorization = null;

    if (session) {

        authorization = MAC.getAuthorizationHeader(method, path, internals.apiHost, internals.apiPort, session, body);

        if (authorization === null ||
            authorization === '') {

            callback(null, 'Failed to create authorization header: ' + session);
        }
    }

    var hreq = Http.request({ host: internals.apiHost, port: internals.apiPort, path: path, method: method }, function (hres) {

        if (hres) {

            var response = '';

            hres.setEncoding('utf8');
            hres.on('data', function (chunk) {

                response += chunk;
            });

            hres.on('end', function () {

                var data = null;
                var error = null;

                try {

                    data = JSON.parse(response);
                }
                catch (err) {

                    error = 'Invalid response body from API server: ' + response + '(' + err + ')';
                }

                if (error) {

                    callback(null, error);
                }
                else if (hres.statusCode === 200) {

                    callback(data, null);
                }
                else {

                    callback(null, data);
                }
            });
        }
        else {

            callback(null, 'Failed sending API server request');
        }
    });

    hreq.on('error', function (err) {

        callback(null, 'HTTP socket error: ' + JSON.stringify(err));
    });

    if (authorization) {

        hreq.setHeader('Authorization', authorization);
    }

    if (body !== null) {

        hreq.setHeader('Content-Length', body.length);
        hreq.setHeader('Content-Type', 'application/json');
        hreq.write(body);
    }

    hreq.end();
};


