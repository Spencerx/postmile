/*
* Copyright (c) 2011 Yahoo! Inc. All rights reserved. Copyrights licensed under the New BSD License.
* See LICENSE file included with this code project for license terms.
*/

// Load modules

var Email = require('emailjs');
var Db = require('./db');
var Utils = require('./utils');
var Err = require('./error');
var Log = require('./log');
var Vault = require('./vault');
var User = require('./user');


// Generate email ticket

exports.generateTicket = function (user, email, arg1, arg2) {

    var callback = (arg2 ? arg2 : arg1);
    var options = (arg2 ? arg1 : {});

    // Create new ticket

    var now = Utils.getTimestamp();
    var ticketId = now.toString(36);                                                // assuming users cannot generate more than one ticket per msec
    var token = Utils.encrypt(Vault.emailToken.aes256Key, [user._id, ticketId]);

    var ticket = { timestamp: now, email: email };

    if (options.action) {

        ticket.action = options.action;
    }

    if (options.expiresInMin) {

        ticket.expires = now + (options.expiresInMin * 60 * 1000);
    }

    if (options.isSingleUse !== undefined) {

        ticket.isSingleUse = options.isSingleUse;
    }

    var change = { $set: {} };
    change.$set['tickets.' + ticketId] = ticket;

    // Cleanup expired tickets

    if (user.tickets) {

        var expiredIds = [];

        for (var i in user.tickets) {

            if (user.tickets.hasOwnProperty(i)) {

                if (user.tickets[i].expires &&
                    user.tickets[i].expires <= now) {

                    expiredIds.push(i);
                }
            }
        }

        if (expiredIds.length > 0) {

            change.$unset = {};

            for (i = 0, il = expiredIds.length; i < il; ++i) {

                change.$unset['tickets.' + expiredIds[i]] = 1;
            }
        }
    }

    // Save changes

    Db.update('user', user._id, change, function (err) {

        if (err === null) {

            callback(token, null);
        }
        else {

            callback(null, err);
        }
    });
};


// Parse email ticket

exports.loadTicket = function (token, callback) {

    // Decode ticket

    var record = Utils.decrypt(Vault.emailToken.aes256Key, token);

    if (record &&
        record instanceof Array &&
        record.length === 2) {

        var userId = record[0];
        var ticketId = record[1];

        // Load user

        User.load(userId, function (user, err) {

            if (user) {

                // Lookup ticket

                if (user.tickets &&
                    user.tickets[ticketId]) {

                    var ticket = user.tickets[ticketId];
                    var now = Utils.getTimestamp();

                    // Check expiration

                    if ((ticket.expires || Infinity) > now) {

                        // Verify email is still in user emails

                        var email = null;
                        for (var i = 0, il = user.emails.length; i < il; ++i) {

                            if (ticket.email &&
                                user.emails[i].address === ticket.email) {

                                email = user.emails[i];
                                break;
                            }
                        }

                        if (email) {

                            if (email.isVerified !== true ||
                                ticket.isSingleUse) {

                                var change = {};
                                var criteria = null;

                                // Mark as verified

                                if (email.isVerified !== true) {

                                    criteria = { 'emails.address': email.address };
                                    change.$set = { 'emails.$.isVerified': true };
                                }

                                // While at it, cleanup expired tickets

                                if (user.tickets) {

                                    var expiredIds = [];

                                    for (i in user.tickets) {

                                        if (user.tickets.hasOwnProperty(i)) {

                                            if (user.tickets[i].expires &&
                                                user.tickets[i].expires <= now) {

                                                expiredIds.push(i);
                                            }
                                        }
                                    }

                                    if (expiredIds.length > 0) {

                                        change.$unset = change.$unset || {};

                                        for (i = 0, il = expiredIds.length; i < il; ++i) {

                                            change.$unset['tickets.' + expiredIds[i]] = 1;
                                        }
                                    }
                                }

                                // Remove single use token

                                if (ticket.isSingleUse) {

                                    change.$unset = change.$unset || {};
                                    change.$unset['tickets.' + ticketId] = 1;
                                }

                                // Save changes

                                if (criteria) {

                                    Db.updateCriteria('user', user._id, criteria, change, function (err) {

                                        if (err === null) {

                                            callback(ticket, user, null);
                                        }
                                        else {

                                            callback(null, null, err);
                                        }
                                    });
                                }
                                else {

                                    Db.update('user', user._id, change, function (err) {

                                        if (err === null) {

                                            callback(ticket, user, null);
                                        }
                                        else {

                                            callback(null, null, err);
                                        }
                                    });
                                }
                            }
                            else {

                                callback(ticket, user, null);
                            }
                        }
                        else {

                            // Don't cleanup now, do it later
                            callback(null, user, Err.notFound('Email token sent to address no longer associated with this account'));
                        }
                    }
                    else {

                        // Don't cleanup now, do it later
                        callback(null, user, Err.notFound('Expired email token'));
                    }
                }
                else {

                    callback(null, user, Err.notFound('Invalid or expired email token'));
                }
            }
            else {

                callback(null, null, Err.notFound('Unknown email token account'));
            }
        });
    }
    else {

        callback(null, null, Err.internal('Invalid email token syntax'));
    }
};


// Login reminder

exports.sendReminder = function (user, callback) {

    if (user &&
        user.emails &&
        user.emails[0] &&
        user.emails[0].address) {

        var options = { action: { type: 'reminder' }, expiresInMin: 20160 };                      // Two weeks
        exports.generateTicket(user, user.emails[0].address, options, function (ticket, err) {

            if (ticket) {

                var subject = 'Help signing into Sled.com';
                var text = 'Hey ' + (user.name || user.username || user.emails[0].address) + ',\n\n' +
                       'Use this link to sign into Sled: \n\n' +
                       '    https://sled.com/t/' + ticket;

                exports.send(user.emails[0].address, subject, text);
                callback(null);
            }
            else {

                callback(err);
            }
        });
    }
    else {

        callback(Err.internal('User has no email address'));
    }
};


// New address validation

exports.sendValidation = function (user, address, callback) {

    if (user && address) {

        var options = { action: { type: 'verify' }, expiresInMin: 1440, isSingleUse: true };                           // One day
        exports.generateTicket(user, address, options, function (ticket, err) {

            if (ticket) {

                var subject = 'Verify your email addess with Sled.com';
                var text = 'Hey ' + (user.name || user.username || address) + ',\n\n' +
                       'Use this link to verify your email address: \n\n' +
                       '    https://sled.com/t/' + ticket;

                exports.send(address, subject, text);
                callback(null);
            }
            else {

                callback(err);
            }
        });
    }
    else {

        callback(Err.internal('User has no email address'));
    }
};


// New address validation

exports.sendWelcome = function (user, callback) {

    if (user &&
        user.emails &&
        user.emails[0] &&
        user.emails[0].address) {

        var options = null;
        var address = user.emails[0].address;
        var subject = 'Welcome to Sled.com';
        var text = 'Hey ' + (user.name || user.username || address) + ',\n\n' +
                   'We are excited to have you!\n\n';

        if (user.emails[0].isVerified !== true) {

            // Email verification email

            options = { action: { type: 'verify' }, expiresInMin: 1440, isSingleUse: true };                           // One day
            exports.generateTicket(user, address, options, function (ticket, err) {

                if (ticket) {

                    text += 'Use this link to verify your email address: \n\n';
                    text += '    https://sled.com/t/' + ticket + '\n\n';

                    exports.send(address, subject, text);
                    callback(null);
                }
                else {

                    callback(err);
                }
            });
        }
        else if (user.twitter ||
                 user.facebook ||
                 user.yahoo) {

            // Plain link

            text += 'Use this link to sign-into Sled: \n\n';
            text += '    https://sled.com/\n\n';

            exports.send(address, subject, text);
            callback(null);
        }
        else {

            // Login link email

            options = { action: { type: 'reminder' }, expiresInMin: 20160 };                      // Two weeks
            exports.generateTicket(user, address, options, function (ticket, err) {

                if (ticket) {

                    text += 'Since you have not yet linked a Facebook, Twitter, or Yahoo! account, you will need to use this link to sign back into Sled: \n\n';
                    text += '    https://sled.com/t/' + ticket + '\n\n';

                    exports.send(address, subject, text);
                    callback(null);
                }
                else {

                    callback(err);
                }
            });
        }
    }
    else {

        callback(Err.internal('User has no email address'));
    }
};


// Invite sled participants

exports.sledInvite = function (users, pids, sled, message, inviter) {

    if (inviter &&
        inviter.emails &&
        inviter.emails[0] &&
        inviter.emails[0].address) {

        var subject = null;
        var link = null;
        var from = (inviter.name || inviter.username) ? (inviter.name || inviter.username) + ' (' + inviter.emails[0].address + ')'
                                                      : inviter.emails[0].address;

        var text = from + ' invited you to collaborate on \'' + sled.title + '\'' +
                   (message ? ', and included the following message: ' + message : '.') + '\n\n';

        // Existing users

        for (var i = 0, il = users.length; i < il; ++i) {

            if (users[i].emails &&
                users[i].emails[0] &&
                users[i].emails[0].address) {

                subject = 'Invitation to participate in ' + sled.title;
                link = 'Use this link to join: \n\n' +
                       '    https://sled.com/view/#sled=' + sled._id;

                exports.send(users[i].emails[0].address,
                             subject,
                             'Hi ' + (users[i].name || users[i].username || users[i].emails[0].address) + ',\n\n' + text + link);
            }
        }

        // New users

        for (i = 0, il = pids.length; i < il; ++i) {

            var pid = pids[i];            // { pid, display, isPending, email, code, inviter }

            if (pid.email) {

                subject = 'Invitation to join Sled.com and participate in ' + sled.title;
                var invite = 'sled:' + sled._id + ':' + pid.pid + ':' + pid.code;
                link = 'Use this link to join: \n\n' +
                       '    https://sled.com/i/' + invite;

                exports.send(pid.email, subject, 'Hi ' + (pid.display || pid.email) + ',\n\n' + text + link, null, function (err) {

                    if (err === null) {

                        Log.info('Email sent to: ' + pid.email + ' for sled: ' + sled._id);
                    }
                    else {

                        Log.err('Email error: ' + pid.email + ' for sled: ' + sled._id);
                    }
                });
            }
            else {

                Log.err('Email error: sled (' + sled._id + ') pid (' + pid.pid + ') missing email address');
            }
        }
    }
};


// Send message

exports.send = function (to, subject, text, html, callback) {

    var headers = {

        from: 'Sled.com <no-reply@sled.com>',
        to: to,
        subject: subject,
        text: text
    };

    var message = Email.message.create(headers);

    if (html) {

        message.attach_alternative(html);
    }

    var mailer = Email.server.connect({ host: 'localhost' });
    mailer.send(message, function (err, message) {

        if (err === null ||
            err === undefined) {

            if (callback) {

                callback(null);
            }
        }
        else {

            if (callback) {

                callback(Err.internal('Failed sending email: ' + JSON.stringify(err)));
            }
            else {

                Log.err('Email error: ' + err);
            }
        }
    });
};


