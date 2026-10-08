/*
 * sanitizer.js
 *
 * Pure PII-sanitization logic for the PII Cleaner app.
 * No DOM access. Loadable from Node (module.exports), a browser (window.PIISanitizer),
 * or any other JS host exposing globalThis (e.g. JavaScriptCore: globalThis.PIISanitizer).
 *
 * See docs/SPEC.md for the authoritative design. This file implements:
 *  - Pass 1: structured field recognition over parsed JSON (FIELD_MAP)
 *  - Pass 2: custom user-supplied lists (added to the shared dictionary)
 *  - Pass 3: ordered regex sweep over every string value / raw text
 *  - Leak check: re-run of passes 2-3 detectors over the final output
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------

  var TYPES = ['HOST', 'USER', 'DOMAIN', 'OU', 'EMAIL', 'IP', 'MAC', 'SID', 'ID', 'PATH', 'URL', 'PHONE', 'CUSTOM'];

  // Active Directory names (hosts, users, domains, OUs) are case-insensitive.
  var CASE_INSENSITIVE_TYPES = new Set(['HOST', 'USER', 'DOMAIN', 'OU', 'EMAIL']);

  // OU names are mostly generic vocabulary ("Computers", "Laptops", "Finance"), so
  // unlike hosts and users they are NOT replaced wherever they appear. Outside their
  // own fields they are replaced only where the surrounding text proves they are OUs:
  // an `OU=` component of a distinguished name, or a backslash-joined path made
  // entirely of already-learned OUs. The leak check applies the same rule.
  var CONTEXT_ONLY_TYPES = new Set(['OU']);

  // Subtrees with their own rules. Keyed by lower-cased key name (matched at any
  // depth). Values:
  //   '*'                       skip outright: no pass touches it, nothing is
  //                             learned from it, the leak check ignores it
  //   ['DOMAIN', ...]           only the listed types are switched off beneath it
  //   { mode: 'learned',        nothing is detected or learned inside, but values
  //     privateIps: true }      already known from elsewhere (and custom lists) are
  //                             still replaced; privateIps also tokenizes RFC 1918,
  //                             link-local and loopback addresses found inside
  // Outgoing-traffic destinations are the first case: the far end of a connection
  // is not ours, but our own hosts, users and private addresses still are.
  var EXEMPT_SUBTREES = {
    analysis_hour_destinations: { mode: 'learned', privateIps: true }
  };

  // Normalized rule for the values under `key`: null, 'skip', { off: [...] } or
  // { learned: true, privateIps: bool }.
  function subtreeRule(key) {
    if (key == null) return null;
    var v = EXEMPT_SUBTREES[String(key).toLowerCase()];
    if (!v) return null;
    if (v === '*') return 'skip';
    if (Array.isArray(v)) return { off: v };
    if (v.mode === 'learned') return { learned: true, privateIps: !!v.privateIps };
    return null;
  }

  function skipSubtree(key) { return subtreeRule(key) === 'skip'; }

  // `enabled` for the values under `key`: the same object unless the key opens a
  // partially exempt subtree, in which case a copy with those types off.
  function subtreeEnabled(enabled, key) {
    var rule = subtreeRule(key);
    if (!rule || !rule.off) return enabled;
    var copy = Object.assign({}, enabled);
    for (var i = 0; i < rule.off.length; i++) copy[rule.off[i]] = false;
    return copy;
  }

  // Addresses that are local by definition: RFC 1918, link-local, loopback, ULA.
  var PRIVATE_IPV4_RE = /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
  var PRIVATE_IPV6_RE = /^(?:f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:|::1$)/i;
  function isPrivateIp(v) {
    return PRIVATE_IPV4_RE.test(v) || PRIVATE_IPV6_RE.test(v);
  }
  // `OU=<name>` inside a DN; the value runs to the next `,` / `;` / `+` or line end,
  // tolerating LDAP-escaped characters ("OU=Sales\, EMEA").
  var DN_OU_RE = /(?<![\p{L}\p{N}_])OU=((?:\\.|[^,;+\r\n])*?)(?=[ \t]*(?:[,;+]|$))/gimu;

  // Built-in key map. Keys are lower-cased leaf key names. Extend freely.
  var FIELD_MAP = {
    HOST: ['computername', 'hostname', 'host_name', 'device_name', 'hostnames', 'asset', 'asset_name', 'source_host', 'destination_host'],
    USER: ['username', 'user_name', 'user', 'userprincipal', 'logon_user', 'account', 'source_user', 'destination_user', 'samaccountname', 'actor_user', 'target_user', 'logonuser',
      // Rapid7 IDR account fields; values are often display names ("Firstname Lastname")
      'account_name', 'account_names', 'source_account_name', 'source_account_names', 'destination_account_name', 'destination_account_names',
      // Identity / display-name fields; values are often "Lastname, Firstname"
      'identity', 'userdisplayname', 'user_display_name', 'displayname', 'display_name'],
    DOMAIN: ['machinedomain', 'logondomain', 'domain', 'userdomain', 'dns_domain', 'source_domain'],
    // Organizational units. CrowdStrike hosts carry `ou` (one OU per element) and
    // `active_directory_dn_display` (backslash-joined OU paths, "Laptops\\Computers\\Finance").
    OU: ['ou', 'ous', 'organizational_unit', 'organizationalunit', 'org_unit', 'ou_display', 'active_directory_dn_display'],
    EMAIL: ['email', 'mail', 'user_email', 'email_address', 'sender', 'recipient'],
    IP: ['localaddressip4', 'remoteaddressip4', 'localaddressip6', 'remoteaddressip6', 'aip', 'ip', 'ip_address',
      'source_ip', 'destination_ip', 'src_ip', 'dst_ip', 'external_ip', 'local_ip', 'remote_ip', 'public_ip',
      'address', 'ipv4', 'ipv6', 'addresses'],
    MAC: ['mac', 'mac_address', 'physicaladdress', 'macs'],
    SID: ['usersid', 'usersid_readable', 'sid', 'logonsid'],
    ID: ['aid', 'cid', 'agent_id', 'agentid', 'device_id', 'deviceid', 'asset_id', 'sensorid', 'serial',
      'serial_number', 'serialnumber', 'systemserialnumber', 'biosserial', 'uuid', 'guid', 'id', 'ids', 'organization_id', 'customer_id'],
    PATH: ['imagefilename', 'filepath', 'targetfilename', 'path', 'file_path', 'commandline'],
    URL: ['url', 'uri', 'httpurl', 'domainname', 'request_url', 'referer'],
    PHONE: ['phone', 'phone_number', 'mobile']
  };

  var FIELD_MAP_SETS = {};
  Object.keys(FIELD_MAP).forEach(function (t) {
    FIELD_MAP_SETS[t] = new Set(FIELD_MAP[t]);
  });

  var TLD_ALLOWLIST = new Set(['com', 'net', 'org', 'local', 'lan', 'corp', 'internal', 'io', 'edu', 'gov', 'mil', 'co', 'uk', 'de']);

  var TOKEN_EXACT_RE = /^\{\{[A-Z]+_\d+\}\}$/;

  var EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  var URL_RE = /\b(?:https?|ftp):\/\/[^\s"'<>]+/gi;
  // Trailing sentence punctuation is not part of a URL ("see https://x.example.com/a.").
  var URL_TRAILING_PUNCT_RE = /[.,;:!?)\]}]+$/;
  // IPv4: not part of a longer dotted-number run such as a version string 1.2.3.4.5.
  var IPV4_RE = /(?<![\d.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?!\.?\d)/g;
  // IPv6: full 8-group form, embedded-IPv4 forms, and `::`-compressed forms.
  // Requires either 8 groups or a `::`, so timestamps (14:22:10) and MACs never match.
  var IPV6_RE = (function () {
    var h = '[0-9A-Fa-f]{1,4}';
    var v4 = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)){3}';
    var alts = [
      '(?:' + h + ':){7}' + h,
      '(?:' + h + ':){6}' + v4,
      '::(?:[Ff]{4}(?::0{1,4})?:)?' + v4,
      '(?:' + h + ':){1,4}:' + v4,
      '(?:' + h + ':){1,7}:',
      '(?:' + h + ':){1,6}:' + h,
      '(?:' + h + ':){1,5}(?::' + h + '){1,2}',
      '(?:' + h + ':){1,4}(?::' + h + '){1,3}',
      '(?:' + h + ':){1,3}(?::' + h + '){1,4}',
      '(?:' + h + ':){1,2}(?::' + h + '){1,5}',
      h + ':(?::' + h + '){1,6}',
      ':(?:(?::' + h + '){1,7}|:)'
    ];
    return new RegExp('(?<![\\w:.])(?:' + alts.join('|') + ')(?![\\w:]|\\.\\d)', 'g');
  })();
  var MAC_RE = /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b|\b(?:[0-9A-Fa-f]{4}\.){2}[0-9A-Fa-f]{4}\b/g;
  var SID_RE = /\bS-1-\d+(?:-\d+){1,14}\b/g;
  var GUID_RE = /\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/g;
  // Case-insensitive (c:\users\jdoe is common in command lines); tolerates JSON-escaped
  // double backslashes. A segment followed by another backslash may contain spaces
  // ("John Doe\Desktop"); a final segment stops at whitespace so trailing args are kept.
  var WIN_PATH_RE = /([A-Za-z]:\\{1,2}Users\\{1,2})([^\\/:*?"<>|\r\n]+(?=\\)|[^\\/:*?"<>|\s]+)/gi;
  var POSIX_HOME_RE = /(\/home\/)([^/\s"']+)/g;
  var POSIX_USERS_RE = /(\/Users\/)([^/\s"']+)/g;
  var FQDN_RE = /\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}\b/g;
  // host labels immediately preceding an already-emitted DOMAIN token: "fileserver01.{{DOMAIN_1}}"
  var HOST_BEFORE_DOMAIN_RE = /(?<![\p{L}\p{N}_.\-])((?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+)(?=\{\{DOMAIN_\d+\}\})/gu;
  // UNC host that was never learned (leak-check heuristic only): \\HOST\share (1-2x escaped)
  var UNC_HOST_RE = /(?<![\\\w])\\{2,4}([A-Za-z0-9][A-Za-z0-9_-]{0,62})(?=\\|\.|\s|$)/g;
  var PHONE_RE = /\+\d{8,15}\b|(?<!\d)(?:\+?1[-.\s])?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g;

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------

  function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // `\b`-style boundaries, Unicode-aware: a learned value matches only when it is not
  // glued to another letter/digit/underscore. So `\`, `/`, `@`, `.`, `:`, quotes,
  // whitespace, `,`, `=`, `(`, `;` etc. are all boundaries (`CORP\jdoe`, `user=jdoe`,
  // `(jdoe)` match) but `jdoeadmin` / `jdoe_old` do not.
  var WORD_CHAR = '[\\p{L}\\p{N}\\p{M}_]';

  function buildBoundaryRegex(value, caseInsensitive, noBoundary) {
    var esc = escapeRegex(value);
    var pattern = noBoundary ? esc : '(?<!' + WORD_CHAR + ')' + esc + '(?!' + WORD_CHAR + ')';
    return new RegExp(pattern, 'gu' + (caseInsensitive ? 'i' : ''));
  }

  // Custom values that contain punctuation (anything other than letters, digits,
  // `_`, `-`, `.`) are matched without boundaries, per SPEC pass 2.
  function hasPunctuation(value) {
    return /[^\p{L}\p{N}\p{M}_.\-]/u.test(value);
  }

  function entryRegex(entry) {
    var ci = CASE_INSENSITIVE_TYPES.has(entry.type);
    var sig = (ci ? 'i' : '') + (entry.noBoundary ? 'n' : '');
    if (!entry._re || entry._reSig !== sig) {
      Object.defineProperty(entry, '_re', { value: buildBoundaryRegex(entry.original, ci, entry.noBoundary), writable: true, configurable: true, enumerable: false });
      Object.defineProperty(entry, '_reSig', { value: sig, writable: true, configurable: true, enumerable: false });
    }
    entry._re.lastIndex = 0;
    return entry._re;
  }

  function entryLc(entry) {
    if (entry._lc === undefined) {
      Object.defineProperty(entry, '_lc', { value: String(entry.original).toLowerCase(), writable: true, configurable: true, enumerable: false });
    }
    return entry._lc;
  }

  function isTokenString(value) {
    return TOKEN_EXACT_RE.test(value);
  }

  function normalizeKey(type, value) {
    return CASE_INSENSITIVE_TYPES.has(type) ? String(value).toLowerCase() : String(value);
  }

  function isIdLike(value) {
    if (/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(value)) return true;
    if (/^[0-9A-Fa-f]{16,}$/.test(value)) return true;
    return false;
  }

  function looksLikeEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  function isMacShaped(str) {
    if (str.indexOf('::') !== -1) return false;
    var parts = str.split(':');
    return parts.length === 6 && parts.every(function (p) { return /^[0-9A-Fa-f]{2}$/.test(p); });
  }

  function extractN(token) {
    var m = /_([0-9]+)\}\}$/.exec(token);
    return m ? parseInt(m[1], 10) : 0;
  }

  // Walk str, applying cb(nonTokenChunk) to each span of str that is NOT
  // already a {{TYPE_N}} token, and leaving token spans untouched.
  // Uses a local regex so callbacks may nest (no shared lastIndex).
  function mapOutsideTokens(str, cb) {
    var parts = String(str).split(/(\{\{[A-Z]+_\d+\}\})/);
    for (var i = 0; i < parts.length; i += 2) parts[i] = cb(parts[i]);
    return parts.join('');
  }

  // Walk str, calling cb(nonTokenChunk, absoluteOffset) for each non-token span.
  function forEachNonTokenSpan(str, cb) {
    var re = /\{\{[A-Z]+_\d+\}\}/g;
    var lastIndex = 0;
    var m;
    while ((m = re.exec(str)) !== null) {
      if (m.index > lastIndex) cb(str.slice(lastIndex, m.index), lastIndex);
      lastIndex = m.index + m[0].length;
    }
    if (lastIndex < str.length) cb(str.slice(lastIndex), lastIndex);
  }

  // ---------------------------------------------------------------------
  // Dictionary primitives (operate on a session's internal `state`)
  // ---------------------------------------------------------------------

  function getOrCreateEntry(state, type, original) {
    var key = type + '\u0000' + normalizeKey(type, original);
    var entry = state._byKey.get(key);
    if (!entry) {
      var token;
      do {
        state.counters[type] = (state.counters[type] || 0) + 1;
        token = '{{' + type + '_' + state.counters[type] + '}}';
      } while (state._byToken.has(token) || state._reservedTokens.has(token));
      entry = { token: token, type: type, original: original, count: 0 };
      state._byKey.set(key, entry);
      state._byToken.set(token, entry);
      state._sorted = null;
      state._ouPathRe = null;
    }
    return entry;
  }

  function emitToken(state, type, original, statsAcc) {
    var entry = getOrCreateEntry(state, type, original);
    entry.count++;
    if (statsAcc) {
      statsAcc.byType[type] = (statsAcc.byType[type] || 0) + 1;
      statsAcc.total++;
    }
    return entry.token;
  }

  // Learn (without counting a replacement) the user/domain halves of an address.
  function learnEmailParts(addr, state) {
    var atIdx = addr.lastIndexOf('@');
    if (atIdx <= 0 || atIdx === addr.length - 1) return;
    getOrCreateEntry(state, 'USER', addr.slice(0, atIdx));
    getOrCreateEntry(state, 'DOMAIN', addr.slice(atIdx + 1));
  }

  function emitEmail(addr, state, statsAcc) {
    learnEmailParts(addr, state);
    return emitToken(state, 'EMAIL', addr, statsAcc);
  }

  var IPV4_EXACT_RE = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

  function learnUrlHost(urlStr, state) {
    var m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@\/?#\s]*@)?(\[[^\]]+\]|[^\/:?#\s]+)/.exec(urlStr);
    if (!m) return;
    var host = m[1];
    if (host.charAt(0) === '[') {
      getOrCreateEntry(state, 'IP', host.slice(1, -1));
      return;
    }
    if (IPV4_EXACT_RE.test(host)) {
      getOrCreateEntry(state, 'IP', host);
      return;
    }
    var lc = host.toLowerCase();
    if (lc === 'localhost') return;
    if (state._byKey.has('HOST\u0000' + lc) || state._byKey.has('DOMAIN\u0000' + lc)) return;
    getOrCreateEntry(state, host.indexOf('.') !== -1 ? 'DOMAIN' : 'HOST', host);
  }

  function emitUrl(urlStr, state, statsAcc) {
    learnUrlHost(urlStr, state);
    return emitToken(state, 'URL', urlStr, statsAcc);
  }

  // OU field values are either a single OU name ("Accounting Dept") or a backslash-
  // joined OU path ("Laptops\\Computers\\Accounting Dept", single or JSON-escaped
  // double backslashes). Each path segment becomes its own {{OU_N}} token, so the same
  // OU shares a token whether it appears alone (`ou`) or inside a path
  // (`active_directory_dn_display`), and the hierarchy depth stays visible.
  function tokenizeOuPath(value, state, statsAcc) {
    return value.replace(/[^\\]+/g, function (segment) {
      var m = /^(\s*)(.*?)(\s*)$/.exec(segment);
      var name = m[2];
      if (!name || isTokenString(name)) return segment;
      return m[1] + emitToken(state, 'OU', name, statsAcc) + m[3];
    });
  }

  // Matches two or more learned OU names joined by backslashes (1-2x escaped), e.g.
  // "Laptops\\Computers\\Accounting Dept" quoted in free text. Null until two OUs are known.
  function ouPathRegex(state) {
    if (state._ouPathRe === undefined || state._ouPathRe === null) {
      var names = [];
      state._byKey.forEach(function (e) {
        if (e.type === 'OU' && e.original && !isTokenString(String(e.original))) names.push(String(e.original));
      });
      if (names.length < 2) {
        state._ouPathRe = false;
      } else {
        names.sort(function (a, b) { return b.length - a.length; });
        var alt = '(?:' + names.map(escapeRegex).join('|') + ')';
        state._ouPathRe = new RegExp('(?<!' + WORD_CHAR + ')' + alt + '(?:\\\\{1,2}' + alt + ')+(?!' + WORD_CHAR + ')', 'giu');
      }
    }
    if (state._ouPathRe) state._ouPathRe.lastIndex = 0;
    return state._ouPathRe || null;
  }

  // Free-text OU replacement, restricted to OU contexts (see CONTEXT_ONLY_TYPES).
  function sweepOuContexts(str, state, statsAcc) {
    var s = mapOutsideTokens(str, function (chunk) {
      return chunk.replace(DN_OU_RE, function (m, val) {
        var name = val.trim();
        if (!name || isTokenString(name)) return m;
        return m.slice(0, 3) + val.replace(name, emitToken(state, 'OU', name, statsAcc));
      });
    });
    var re = ouPathRegex(state);
    if (re && re.test(s)) {
      s = mapOutsideTokens(s, function (chunk) {
        return chunk.replace(ouPathRegex(state), function (m) { return tokenizeOuPath(m, state, statsAcc); });
      });
    }
    return s;
  }

  // USER field values like CORP\jdoe or jdoe@corp.example: also learn the bare
  // username (and the domain) so they are replaced when they appear alone elsewhere.
  function learnUserParts(value, state) {
    var bs = /^([^\\\s]+)\\([^\\\s]+)$/.exec(value);
    if (bs) {
      getOrCreateEntry(state, 'DOMAIN', bs[1]);
      getOrCreateEntry(state, 'USER', bs[2]);
      return;
    }
    if (looksLikeEmail(value)) { learnEmailParts(value, state); return; }
    // "Lastname, Firstname" also learns "Firstname Lastname", the form it
    // usually takes in free text.
    var lf = /^\s*([^,]+?)\s*,\s*([^,]+?)\s*$/.exec(value);
    if (lf) getOrCreateEntry(state, 'USER', lf[2] + ' ' + lf[1]);
  }

  // ---------------------------------------------------------------------
  // Pass 1 - structured field recognition
  // ---------------------------------------------------------------------

  function resolveFieldType(leafKey, containerKey) {
    var kl = String(leafKey).toLowerCase();
    var cl = containerKey ? String(containerKey).toLowerCase() : '';
    if (kl === 'name') {
      if (/host|asset|device/.test(cl)) return 'HOST';
      if (cl === 'user') return 'USER';
      return null;
    }
    if (kl === 'authenticationid') return 'SID_MAYBE';
    for (var i = 0; i < TYPES.length; i++) {
      var t = TYPES[i];
      if (FIELD_MAP_SETS[t] && FIELD_MAP_SETS[t].has(kl)) return t;
    }
    return null;
  }

  function tokenizeLeaf(value, leafKey, containerKey, state, enabled, statsAcc) {
    if (!leafKey) return value;
    var type = resolveFieldType(leafKey, containerKey);
    if (!type) return value;
    // Empty / whitespace-only values carry no PII; values that already are a token
    // are protected (sanitizing sanitized output must be a no-op).
    if (!value.trim() || isTokenString(value)) return value;

    if (type === 'SID_MAYBE') {
      if (enabled.SID && /^S-1-/.test(value)) return emitToken(state, 'SID', value, statsAcc);
      return value;
    }
    if (type === 'PATH') return value; // left entirely to the pass-3 sweep

    if (!enabled[type]) return value;

    if (type === 'ID') {
      var kl = String(leafKey).toLowerCase();
      if ((kl === 'id' || kl === 'ids') && !isIdLike(value)) return value;
      return emitToken(state, 'ID', value, statsAcc);
    }
    if (type === 'EMAIL') {
      if (looksLikeEmail(value)) return emitEmail(value, state, statsAcc);
      return value;
    }
    if (type === 'URL') {
      return emitUrl(value, state, statsAcc);
    }
    if (type === 'OU') {
      return tokenizeOuPath(value, state, statsAcc);
    }
    if (type === 'USER') learnUserParts(value, state);
    return emitToken(state, type, value, statsAcc);
  }

  function processValue(value, state, enabled, statsAcc, leafKey, containerKey) {
    var rule = subtreeRule(leafKey);
    if (rule === 'skip' || (rule && rule.learned)) return value; // pass 1 never looks inside
    enabled = subtreeEnabled(enabled, leafKey);
    if (Array.isArray(value)) {
      return value.map(function (v) { return processValue(v, state, enabled, statsAcc, leafKey, containerKey); });
    }
    if (value && typeof value === 'object') {
      return walkNode(value, state, enabled, statsAcc, leafKey);
    }
    if (typeof value === 'string') {
      return tokenizeLeaf(value, leafKey, containerKey, state, enabled, statsAcc);
    }
    return value;
  }

  function walkNode(node, state, enabled, statsAcc, containerKey) {
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) {
        node[i] = processValue(node[i], state, enabled, statsAcc, containerKey, containerKey);
      }
      return node;
    }
    if (node && typeof node === 'object') {
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        node[key] = processValue(node[key], state, enabled, statsAcc, key, containerKey);
      }
      return node;
    }
    return node;
  }

  // Second tree walk: pass-3 regex sweep applied to every string leaf,
  // regardless of key, after pass 1 has already tokenized recognised fields.
  // `learned` is the { learned, privateIps } rule in force (see EXEMPT_SUBTREES),
  // or null for the full sweep.
  function sweepTree(node, state, enabled, statsAcc, learned) {
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) node[i] = sweepTree(node[i], state, enabled, statsAcc, learned);
      return node;
    }
    if (node && typeof node === 'object') {
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) {
        var rule = subtreeRule(keys[k]);
        if (rule === 'skip') continue;
        var childLearned = (rule && rule.learned) ? rule : learned;
        node[keys[k]] = sweepTree(node[keys[k]], state, subtreeEnabled(enabled, keys[k]), statsAcc, childLearned);
      }
      return node;
    }
    if (typeof node === 'string') {
      return learned ? sweepLearned(node, state, enabled, statsAcc, learned.privateIps) : sweepString(node, state, enabled, statsAcc);
    }
    return node;
  }

  // Reduced sweep for 'learned' subtrees: values already known (custom lists are
  // part of the dictionary), host labels in front of a learned domain token, and
  // optionally private addresses. No other detector, so nothing new is learned
  // from the subtree except those private addresses.
  function sweepLearned(str, state, enabled, statsAcc, privateIps) {
    var s = dictionaryReplace(str, state, enabled, statsAcc);
    s = tokenizeHostBeforeDomain(s, state, enabled, statsAcc);
    if (privateIps && enabled.IP) {
      s = mapOutsideTokens(s, function (chunk) {
        return chunk.replace(IPV6_RE, function (m) {
          if (isMacShaped(m) || !/\d/.test(m) || !isPrivateIp(m)) return m;
          return emitToken(state, 'IP', m, statsAcc);
        });
      });
      s = mapOutsideTokens(s, function (chunk) {
        return chunk.replace(IPV4_RE, function (m) { return isPrivateIp(m) ? emitToken(state, 'IP', m, statsAcc) : m; });
      });
    }
    return s;
  }

  // ---------------------------------------------------------------------
  // Pass 3 - ordered regex sweep (also used for raw-text mode)
  // ---------------------------------------------------------------------

  function sortedEntries(state) {
    if (!state._sorted) {
      state._sorted = Array.from(state._byKey.values()).filter(function (e) {
        return e.original != null && String(e.original).length > 0 && !isTokenString(String(e.original));
      });
      state._sorted.sort(function (a, b) { return String(b.original).length - String(a.original).length; });
    }
    return state._sorted;
  }

  // Replace every learned value (longest first). Each entry is applied only to the
  // non-token spans of the current string, so a later (shorter / punctuation) entry
  // can never match inside a token emitted by an earlier entry.
  function dictionaryReplace(str, state, enabled, statsAcc) {
    var entries = sortedEntries(state);
    var result = str;
    // Cheap prefilter: an entry can only match if its lower-cased text occurs in the
    // lower-cased input. Replacements only remove text, so this stays a superset.
    var lc = str.toLowerCase();
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (!enabled[entry.type] || CONTEXT_ONLY_TYPES.has(entry.type)) continue;
      if (lc.indexOf(entryLc(entry)) === -1) continue;
      var re = entryRegex(entry);
      if (!re.test(result)) continue;
      result = mapOutsideTokens(result, function (chunk) {
        var r = entryRegex(entry);
        return chunk.replace(r, function () {
          entry.count++;
          if (statsAcc) {
            statsAcc.byType[entry.type] = (statsAcc.byType[entry.type] || 0) + 1;
            statsAcc.total++;
          }
          return entry.token;
        });
      });
    }
    return result;
  }

  // "fileserver01.{{DOMAIN_1}}": the domain suffix was learned, the host label was not.
  // Tokenize the label(s) as HOST so the FQDN does not leak a hostname (SPEC step 9).
  function tokenizeHostBeforeDomain(str, state, enabled, statsAcc) {
    if (!enabled.HOST || str.indexOf('{{DOMAIN_') === -1) return str;
    HOST_BEFORE_DOMAIN_RE.lastIndex = 0;
    return str.replace(HOST_BEFORE_DOMAIN_RE, function (m, labels) {
      var host = labels.slice(0, -1);
      return emitToken(state, 'HOST', host, statsAcc) + '.';
    });
  }

  function sweepString(str, state, enabled, statsAcc) {
    var s = str;

    // 0a. EMAIL (runs before the dictionary pass so a whole email becomes one
    // {{EMAIL_N}} token even when its user/domain were already learned elsewhere)
    if (enabled.EMAIL) {
      s = mapOutsideTokens(s, function (chunk) {
        return chunk.replace(EMAIL_RE, function (m) { return emitEmail(m, state, statsAcc); });
      });
    }

    // 0b. URL (same reasoning: runs before the dictionary pass so a whole URL
    // becomes one {{URL_N}} token even when its host was already learned)
    if (enabled.URL) {
      s = mapOutsideTokens(s, function (chunk) {
        return chunk.replace(URL_RE, function (m) {
          var trail = '';
          var t = URL_TRAILING_PUNCT_RE.exec(m);
          if (t) { trail = t[0]; m = m.slice(0, m.length - trail.length); }
          if (!/:\/\/./.test(m)) return m + trail;
          return emitUrl(m, state, statsAcc) + trail;
        });
      });
    }

    // 1. dictionary replacement (all learned values so far, longest first)
    s = dictionaryReplace(s, state, enabled, statsAcc);

    // 1b. OU contexts only: `OU=` DN components and backslash paths of learned OUs.
    if (enabled.OU) s = sweepOuContexts(s, state, statsAcc);

    // 4. IPv6 (first, so embedded-IPv4 forms like ::ffff:10.0.0.1 stay one token) / IPv4
    if (enabled.IP) {
      s = mapOutsideTokens(s, function (chunk) {
        return chunk.replace(IPV6_RE, function (m) {
          if (isMacShaped(m)) return m;
          // "::Add" in [Type]::Add(...) is PowerShell, not an address: require a digit.
          if (!/\d/.test(m)) return m;
          return emitToken(state, 'IP', m, statsAcc);
        });
      });
      s = mapOutsideTokens(s, function (chunk) {
        return chunk.replace(IPV4_RE, function (m) { return emitToken(state, 'IP', m, statsAcc); });
      });
    }

    // 5. MAC
    if (enabled.MAC) {
      s = mapOutsideTokens(s, function (chunk) {
        return chunk.replace(MAC_RE, function (m) { return emitToken(state, 'MAC', m, statsAcc); });
      });
    }

    // 6. SID
    if (enabled.SID) {
      s = mapOutsideTokens(s, function (chunk) {
        return chunk.replace(SID_RE, function (m) { return emitToken(state, 'SID', m, statsAcc); });
      });
    }

    // 7. GUID/UUID -> ID
    if (enabled.ID) {
      s = mapOutsideTokens(s, function (chunk) {
        return chunk.replace(GUID_RE, function (m) { return emitToken(state, 'ID', m, statsAcc); });
      });
    }

    // 8. Windows/POSIX user path segments -> USER (needs both PATH and USER enabled)
    if (enabled.PATH && enabled.USER) {
      [WIN_PATH_RE, POSIX_HOME_RE, POSIX_USERS_RE].forEach(function (re) {
        s = mapOutsideTokens(s, function (chunk) {
          return chunk.replace(re, function (m, p1, p2) {
            return p1 + emitToken(state, 'USER', p2, statsAcc);
          });
        });
      });
    }

    // 9. FQDN-like tokens with allow-listed TLD -> DOMAIN; plus host labels in front
    // of an already-tokenized learned domain -> HOST.
    s = tokenizeHostBeforeDomain(s, state, enabled, statsAcc);
    if (enabled.DOMAIN) {
      s = mapOutsideTokens(s, function (chunk) {
        return chunk.replace(FQDN_RE, function (m) {
          var tld = m.split('.').pop().toLowerCase();
          if (!TLD_ALLOWLIST.has(tld)) return m;
          return emitToken(state, 'DOMAIN', m, statsAcc);
        });
      });
    }

    // 10. PHONE
    if (enabled.PHONE) {
      s = mapOutsideTokens(s, function (chunk) {
        return chunk.replace(PHONE_RE, function (m) { return emitToken(state, 'PHONE', m, statsAcc); });
      });
    }

    return s;
  }

  // ---------------------------------------------------------------------
  // Leak check
  // ---------------------------------------------------------------------

  // `texts` is an array of strings to scan: the string leaves of sanitized JSON (so
  // JSON escaping such as `\\` never hides a match) or the raw-text output. A leaf
  // from an exempt subtree comes as { text, enabled } carrying its own type set.
  function findLeaks(texts, state, enabled) {
    var defaultEnabled = enabled;
    var leaks = [];
    var seen = new Set();

    function scanRe(re, chunk, offset, outputText, type, group, filter) {
      var m;
      re.lastIndex = 0;
      while ((m = re.exec(chunk)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        var v = group ? m[group] : m[0];
        if (filter && !filter(v)) continue;
        var idx = offset + m.index + (group ? m[0].indexOf(v) : 0);
        report(outputText, v, type, idx);
      }
    }

    function report(outputText, value, type, absIdx) {
      if (value == null || value === '') return;
      var key = type + '\u0000' + value;
      if (seen.has(key)) return;
      seen.add(key);
      var start = Math.max(0, absIdx - 20);
      var end = Math.min(outputText.length, absIdx + String(value).length + 20);
      leaks.push({ value: value, type: type, context: outputText.slice(start, end) });
    }

    texts.forEach(function (item) {
      var outputText = (item && typeof item === 'object') ? item.text : item;
      var enabled = (item && typeof item === 'object' && item.enabled) ? item.enabled : defaultEnabled;
      // a leaf from a 'learned' subtree: only known values (and private addresses) count
      var learned = (item && typeof item === 'object' && item.learned) ? item.learned : null;
      if (typeof outputText !== 'string' || !outputText) return;

      // host label glued to a domain token: "fileserver01.{{DOMAIN_1}}"
      if (enabled.HOST) scanRe(HOST_BEFORE_DOMAIN_RE, outputText, 0, outputText, 'HOST', 1, null);

      var lcText = outputText.toLowerCase();
      forEachNonTokenSpan(outputText, function (chunk, offset) {
        // custom-list verbatim leaks
        Object.keys(state.customListValues).forEach(function (type) {
          if (!enabled[type]) return;
          state.customListValues[type].forEach(function (val) {
            if (!val || lcText.indexOf(val.toLowerCase()) === -1) return;
            var re = buildBoundaryRegex(val, CASE_INSENSITIVE_TYPES.has(type), hasPunctuation(val));
            scanRe(re, chunk, offset, outputText, type, 0, null);
          });
        });

        // any learned dictionary value still present verbatim
        state._byKey.forEach(function (entry) {
          if (!enabled[entry.type] || !entry.original || CONTEXT_ONLY_TYPES.has(entry.type)) return;
          if (lcText.indexOf(entryLc(entry)) === -1 || isTokenString(String(entry.original))) return;
          scanRe(entryRegex(entry), chunk, offset, outputText, entry.type, 0, null);
        });

        if (learned) {
          if (learned.privateIps && enabled.IP) {
            scanRe(IPV6_RE, chunk, offset, outputText, 'IP', 0, function (v) { return !isMacShaped(v) && /\d/.test(v) && isPrivateIp(v); });
            scanRe(IPV4_RE, chunk, offset, outputText, 'IP', 0, isPrivateIp);
          }
          return;
        }

        if (enabled.OU) {
          scanRe(DN_OU_RE, chunk, offset, outputText, 'OU', 1, function (v) { return v.trim().length > 0; });
          var ouRe = ouPathRegex(state);
          if (ouRe) scanRe(ouRe, chunk, offset, outputText, 'OU', 0, null);
        }
        if (enabled.EMAIL) scanRe(EMAIL_RE, chunk, offset, outputText, 'EMAIL', 0, null);
        if (enabled.URL) scanRe(URL_RE, chunk, offset, outputText, 'URL', 0, null);
        if (enabled.IP) {
          scanRe(IPV6_RE, chunk, offset, outputText, 'IP', 0, function (v) { return !isMacShaped(v) && /\d/.test(v); });
          scanRe(IPV4_RE, chunk, offset, outputText, 'IP', 0, null);
        }
        if (enabled.MAC) scanRe(MAC_RE, chunk, offset, outputText, 'MAC', 0, null);
        if (enabled.SID) scanRe(SID_RE, chunk, offset, outputText, 'SID', 0, null);
        if (enabled.ID) scanRe(GUID_RE, chunk, offset, outputText, 'ID', 0, null);
        if (enabled.PATH && enabled.USER) {
          scanRe(WIN_PATH_RE, chunk, offset, outputText, 'USER', 2, null);
          scanRe(POSIX_HOME_RE, chunk, offset, outputText, 'USER', 2, null);
          scanRe(POSIX_USERS_RE, chunk, offset, outputText, 'USER', 2, null);
        }
        // UNC host that was never learned: the sanitizer only replaces *learned* hosts
        // in \\HOST\share (SPEC), so surface unknown ones for one-click add.
        if (enabled.HOST) scanRe(UNC_HOST_RE, chunk, offset, outputText, 'HOST', 1, null);
        if (enabled.DOMAIN) {
          scanRe(FQDN_RE, chunk, offset, outputText, 'DOMAIN', 0, function (v) {
            return TLD_ALLOWLIST.has(v.split('.').pop().toLowerCase());
          });
        }
        if (enabled.PHONE) scanRe(PHONE_RE, chunk, offset, outputText, 'PHONE', 0, null);
      });
    });

    return leaks;
  }

  // String leaves for the leak check, each with the type set and subtree rule in
  // force where it sits (see EXEMPT_SUBTREES).
  function collectStrings(node, out, enabled, learned) {
    if (typeof node === 'string') { out.push({ text: node, enabled: enabled, learned: learned || null }); return out; }
    if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) collectStrings(node[i], out, enabled, learned); return out; }
    if (node && typeof node === 'object') {
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) {
        var rule = subtreeRule(keys[k]);
        if (rule === 'skip') continue;
        collectStrings(node[keys[k]], out, subtreeEnabled(enabled, keys[k]), (rule && rule.learned) ? rule : learned);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Format detection
  // ---------------------------------------------------------------------

  // Returns { format, records?, warning? }. `records` holds the parsed values for
  // structured formats so callers do not parse twice.
  function analyzeInput(text) {
    var trimmed = String(text == null ? '' : text).trim();
    if (!trimmed) return { format: 'text' };
    var firstErr;
    try {
      var parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return { format: 'array', records: parsed };
      if (parsed && typeof parsed === 'object') return { format: 'json', records: [parsed] };
      return { format: 'text' };
    } catch (e) {
      firstErr = e;
    }
    var lines = trimmed.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 0; });
    var recs = [];
    var badLine = -1;
    var badErr = null;
    var rawLineNo = 0;
    var allLines = trimmed.split(/\r?\n/);
    for (var i = 0; i < allLines.length; i++) {
      var l = allLines[i].trim();
      if (!l) continue;
      rawLineNo = i + 1;
      try {
        var p = JSON.parse(l);
        if (!p || typeof p !== 'object' || Array.isArray(p)) { badLine = rawLineNo; badErr = new Error('line is not a JSON object'); break; }
        recs.push(p);
      } catch (e2) {
        badLine = rawLineNo; badErr = e2;
        break;
      }
    }
    if (badLine === -1 && recs.length > 1) return { format: 'ndjson', records: recs };
    var c = trimmed.charAt(0);
    var warning;
    if (c === '{' || c === '[') {
      if (recs.length >= 1 && lines.length > 1) {
        warning = 'Input looks like NDJSON but line ' + badLine + ' could not be parsed (' +
          (badErr && badErr.message) + '). Sanitized as raw text instead.';
      } else {
        warning = 'Input looks like JSON but could not be parsed (' + (firstErr && firstErr.message) +
          '). Sanitized as raw text instead.';
      }
    }
    return { format: 'text', warning: warning };
  }

  function detectFormat(text) {
    return analyzeInput(text).format;
  }

  // ---------------------------------------------------------------------
  // Legend helpers
  // ---------------------------------------------------------------------

  function legendEntriesSorted(state) {
    var entries = Array.from(state._byToken.values());
    entries.sort(function (a, b) {
      if (a.type !== b.type) return a.type < b.type ? -1 : 1;
      return extractN(a.token) - extractN(b.token);
    });
    return entries;
  }

  function csvField(v) {
    var s = String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function buildCSV(state) {
    var rows = ['token,type,original,count'];
    legendEntriesSorted(state).forEach(function (e) {
      rows.push([csvField(e.token), csvField(e.type), csvField(e.original), csvField(e.count)].join(','));
    });
    return rows.join('\n');
  }

  function defaultEnabled() {
    var o = {};
    TYPES.forEach(function (t) { o[t] = true; });
    return o;
  }

  // ---------------------------------------------------------------------
  // Public session factory
  // ---------------------------------------------------------------------

  var MAX_SWEEP_ROUNDS = 4;

  function createSession(options) {
    options = options || {};
    var state = {
      _byKey: new Map(),
      _byToken: new Map(),
      _reservedTokens: new Set(),
      _sorted: null,
      _ouPathRe: null,
      counters: {},
      customListValues: { HOST: [], USER: [], DOMAIN: [], CUSTOM: [] }
    };

    // Token-shaped literals already present in the input that this session did not
    // emit: never hand out the same token for a different value.
    function reserveLiteralTokens(text) {
      var re = /\{\{([A-Z]+)_(\d+)\}\}/g;
      var m;
      while ((m = re.exec(text)) !== null) {
        if (!state._byToken.has(m[0])) state._reservedTokens.add(m[0]);
      }
    }

    // Sweep (pass 3) all string leaves of all records; repeat while the sweep itself
    // learned new dictionary values, so a value learned late (later field, later
    // record, a path segment) is also replaced where it appeared earlier.
    function sweepAll(records, enabled, statsAcc) {
      for (var round = 0; round < MAX_SWEEP_ROUNDS; round++) {
        var before = state._byKey.size;
        for (var i = 0; i < records.length; i++) records[i] = sweepTree(records[i], state, enabled, statsAcc);
        if (state._byKey.size === before) break;
      }
    }

    function sweepText(text, enabled, statsAcc) {
      var out = text;
      for (var round = 0; round < MAX_SWEEP_ROUNDS; round++) {
        var before = state._byKey.size;
        out = sweepString(out, state, enabled, statsAcc);
        if (state._byKey.size === before) break;
      }
      return out;
    }

    return {
      // Returns { imported, skipped }. Entries whose token or value conflicts with
      // what this session already holds are skipped (never two values per token).
      importLegend: function (json) {
        if (!json || !Array.isArray(json.entries)) {
          throw new Error('Invalid legend: expected { entries: [...] }');
        }
        var imported = 0;
        var skipped = 0;
        json.entries.forEach(function (e) {
          if (!e || typeof e.token !== 'string' || typeof e.type !== 'string' || e.original == null || e.original === '') { skipped++; return; }
          var tm = /^\{\{([A-Z]+)_(\d+)\}\}$/.exec(e.token);
          if (!tm || tm[1] !== e.type || TYPES.indexOf(e.type) === -1) { skipped++; return; }
          var original = String(e.original);
          var key = e.type + '\u0000' + normalizeKey(e.type, original);
          var existingByKey = state._byKey.get(key);
          var existingByToken = state._byToken.get(e.token);
          if (existingByKey && existingByKey.token === e.token) { imported++; return; }
          if (existingByKey || existingByToken) { skipped++; return; }
          var entry = { token: e.token, type: e.type, original: original, count: Number(e.count) || 0 };
          state._byKey.set(key, entry);
          state._byToken.set(e.token, entry);
          state._sorted = null;
          state._ouPathRe = null;
          var n = parseInt(tm[2], 10);
          if (n > (state.counters[e.type] || 0)) state.counters[e.type] = n;
          imported++;
        });
        return { imported: imported, skipped: skipped };
      },

      exportLegend: function () {
        return {
          version: 1,
          created: new Date().toISOString(),
          entries: legendEntriesSorted(state).map(function (e) {
            return { token: e.token, type: e.type, original: e.original, count: e.count };
          })
        };
      },

      exportLegendCSV: function () {
        return buildCSV(state);
      },

      addCustom: function (type, values) {
        if (['HOST', 'USER', 'DOMAIN', 'CUSTOM'].indexOf(type) === -1) {
          throw new Error('Invalid custom list type: ' + type);
        }
        var list = Array.isArray(values) ? values : String(values == null ? '' : values).split(/\r?\n/);
        list.forEach(function (raw) {
          var v = String(raw == null ? '' : raw).trim();
          if (!v || isTokenString(v)) return;
          var entry = getOrCreateEntry(state, type, v);
          if (hasPunctuation(v)) entry.noBoundary = true;
          if (state.customListValues[type].indexOf(v) === -1) state.customListValues[type].push(v);
        });
      },

      sanitize: function (text, opts) {
        opts = opts || {};
        var enabled = Object.assign(defaultEnabled(), opts.enabled || {});
        var statsAcc = { byType: {}, total: 0 };
        var format = 'text';
        var output = '';
        var records = 0;
        var errorMsg = null;
        var warning = null;
        var leakTexts = [];

        try {
          if (typeof text !== 'string') text = String(text == null ? '' : text);
          reserveLiteralTokens(text);
          var info = analyzeInput(text);
          format = info.format;
          warning = info.warning || null;

          if (format === 'json' || format === 'array' || format === 'ndjson') {
            try {
              var recs = info.records;
              // Pass 1 over every record first, so values learned in any record are
              // known before free text in any record is swept.
              for (var i = 0; i < recs.length; i++) {
                recs[i] = processValue(recs[i], state, enabled, statsAcc, null, null);
              }
              sweepAll(recs, enabled, statsAcc);
              if (format === 'json') output = JSON.stringify(recs[0], null, 2);
              else if (format === 'array') output = JSON.stringify(recs, null, 2);
              else output = recs.map(function (r) { return JSON.stringify(r); }).join('\n');
              records = recs.length;
              leakTexts = collectStrings(recs, [], enabled);
            } catch (deep) {
              if (!(deep instanceof RangeError)) throw deep;
              // e.g. nesting too deep for recursion: still sanitize, as raw text.
              warning = 'Input is valid JSON but too deeply nested to walk (' + deep.message +
                '). Sanitized as raw text instead.';
              format = 'text';
              output = sweepText(text, enabled, statsAcc);
              records = text.trim() ? 1 : 0;
              leakTexts = [output];
            }
          } else {
            output = sweepText(text, enabled, statsAcc);
            records = text.trim() ? 1 : 0;
            leakTexts = [output];
          }
        } catch (e) {
          errorMsg = (e && e.message) ? e.message : String(e);
          output = '';
          records = 0;
        }

        var leaks = errorMsg ? [] : findLeaks(leakTexts, state, enabled);

        return {
          output: output,
          format: format,
          records: records,
          stats: { byType: statsAcc.byType, total: statsAcc.total },
          leaks: leaks,
          warning: warning,
          error: errorMsg
        };
      },

      clear: function () {
        state._byKey.clear();
        state._byToken.clear();
        state._reservedTokens.clear();
        state._sorted = null;
        state._ouPathRe = null;
        state.counters = {};
        state.customListValues = { HOST: [], USER: [], DOMAIN: [], CUSTOM: [] };
      }
    };
  }

  // ---------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------

  var PIISanitizer = {
    createSession: createSession,
    detectFormat: detectFormat,
    analyzeInput: analyzeInput,
    TYPES: TYPES,
    FIELD_MAP: FIELD_MAP,
    EXEMPT_SUBTREES: EXEMPT_SUBTREES
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PIISanitizer;
  }
  var g = (typeof globalThis !== 'undefined') ? globalThis : (typeof window !== 'undefined') ? window : (typeof self !== 'undefined') ? self : this;
  if (g) {
    g.PIISanitizer = PIISanitizer;
  }
})();
