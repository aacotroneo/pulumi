// Host prelude for purejs policy packs. Evaluated in each goja runtime before the pack's bundle.
// Go provides: __log(level, msg), __b64dec(s), __b64enc(s), __parseURL(input, base).
(function (g) {
    "use strict";

    function fmt(args) {
        return Array.prototype.map.call(args, function (a) {
            if (typeof a === "string") return a;
            try { return JSON.stringify(a); } catch (e) { return String(a); }
        }).join(" ");
    }
    g.console = {
        log: function () { __log("info", fmt(arguments)); },
        info: function () { __log("info", fmt(arguments)); },
        debug: function () { __log("debug", fmt(arguments)); },
        warn: function () { __log("warn", fmt(arguments)); },
        error: function () { __log("error", fmt(arguments)); },
    };

    // Minimal Buffer: only what policies use (decode base64/utf8 text and read it back as a string).
    function Buffer(s) { this._s = s; this.length = s.length; }
    Buffer.from = function (input, enc) {
        if (input instanceof Buffer) return new Buffer(input._s);
        if (typeof input !== "string") input = String(input);
        if (enc === "base64" || enc === "base64url") return new Buffer(__b64dec(input));
        return new Buffer(input);
    };
    Buffer.isBuffer = function (b) { return b instanceof Buffer; };
    Buffer.byteLength = function (s) { return typeof s === "string" ? s.length : s.length; };
    Buffer.prototype.toString = function (enc) {
        if (enc === "base64") return __b64enc(this._s);
        return this._s;
    };
    g.Buffer = Buffer;
    g.atob = function (s) { return __b64dec(String(s)); };
    g.btoa = function (s) { return __b64enc(String(s)); };

    function URL(input, base) {
        var r = __parseURL(String(input), base === undefined ? "" : String(base));
        if (!r) throw new TypeError("Invalid URL: " + input);
        for (var k in r) this[k] = r[k];
    }
    URL.prototype.toString = function () { return this.href; };
    URL.prototype.toJSON = function () { return this.href; };
    g.URL = URL;

    function UnknownValueError(path) {
        this.name = "UnknownValueError";
        this.message = "string value at ." + path + " can't be known during preview";
        noteAccess("unk", this.message);
    }
    UnknownValueError.prototype = Object.create(Error.prototype);
    UnknownValueError.prototype.constructor = UnknownValueError;
    g.__unknownGetter = function (path) {
        return function () { throw new UnknownValueError(path); };
    };

    function NotApplicable(reason) { this.reason = reason; }

    // --- ABI v2: identifiable unknowns and the guards that keep them opaque -------------------------------------
    //
    // For a v2 policy, every unknown output is an identifiable unknown: one frozen object per output (created by
    // __unknown), so the same output is identical (===, Set, Map, includes) wherever it appears. It converts to its
    // ref string ("output-<hash>.<property>") only where a string is explicitly asked for (template literals,
    // String(), property keys, JSON). Everything else throws OutputAccessError: reading a property or calling a method
    // on it, numeric or loose (+, ==, <, arithmetic) use, iteration, and string methods, RegExp or JSON.parse applied
    // to it or to its ref string. Adapters for code written for strings read the ref string under
    // Symbol.for("pulumi.unknown"). The string guards are inert (one boolean check) outside v2 policies.
    //
    // A string the program built from unknown outputs with a template (interpolate, concat, jsonStringify) is its text
    // with each unknown as its ref string. It is guarded the same way, except that JSON.parse on a JSON template's text
    // gives the document, with each unknown as its identifiable unknown.
    var refs = new Map();       // ref string or template text -> {urn, type, name, property, derived?}
    var unknowns = new Map();   // ref string -> identifiable unknown
    var unknownInfo = new WeakMap(); // identifiable unknown -> {urn, type, name, property}
    var templates = new Map();  // JSON template text -> its document
    var REF = Symbol.for("pulumi.unknown");
    // Adapters for code written for strings set this while it runs, so that parsed templates hold ref strings.
    var AS_STRINGS = Symbol.for("pulumi.unknownsAsStrings");
    var active = false;
    // The first unknown or output an Input Policy read in the current invocation, and how many violations and passes it
    // had reported by then: a policy that catches the error and carries on reports results that can't be trusted.
    var touched = null, reported = null, passed = null;
    function noteAccess(kind, message) {
        if (active && !touched) {
            touched = { kind: kind, message: message, vAt: reported ? reported.length : 0, pAt: passed ? passed.length : 0 };
        }
    }

    function OutputAccessError(info, op) {
        this.name = "OutputAccessError";
        this.message = info.derived
            ? op + " on '" + info.property + "' of " + info.type + " '" + info.name + "', built from outputs"
            : op + " on the output " + (info.property ? "'" + info.property + "' " : "") + "of " +
                info.type + " '" + info.name + "'";
        noteAccess("out", this.message);
    }
    OutputAccessError.prototype = Object.create(Error.prototype);
    OutputAccessError.prototype.constructor = OutputAccessError;

    var strProto = String.prototype, strValueOf = strProto.valueOf;
    function refInfo(v) {
        if (!active) return undefined;
        if (v !== null && typeof v === "object") {
            var info = unknownInfo.get(v);
            if (info) return info;
            if (v instanceof String) v = strValueOf.call(v);
        }
        return typeof v === "string" ? refs.get(v) : undefined;
    }
    function guard(obj, key, label, checkThis, checkArgs) {
        var orig = obj[key];
        if (typeof orig !== "function") return;
        Object.defineProperty(obj, key, {
            configurable: true, writable: true, enumerable: false,
            value: function () {
                if (active) {
                    var info = checkThis ? refInfo(this) : undefined;
                    for (var i = 0; !info && checkArgs && i < arguments.length; i++) info = refInfo(arguments[i]);
                    if (info) throw new OutputAccessError(info, label);
                }
                return orig.apply(this, arguments);
            },
        });
    }
    ["startsWith", "endsWith", "includes", "indexOf", "lastIndexOf", "split", "match", "matchAll", "search",
        "replace", "replaceAll", "slice", "substring", "substr", "charAt", "charCodeAt", "codePointAt", "at",
        "toUpperCase", "toLocaleUpperCase", "localeCompare", "padStart", "padEnd", "repeat", "normalize",
    ].forEach(function (m) { guard(strProto, m, "." + m + "()", true, true); });
    guard(strProto, Symbol.iterator, "iteration", true, false);
    guard(RegExp.prototype, "test", "RegExp.test()", false, true);
    guard(RegExp.prototype, "exec", "RegExp.exec()", false, true);
    var jsonParse = JSON.parse;
    function cloneTemplate(v, asStrings) {
        if (v === null || typeof v !== "object") return v;
        if (unknownInfo.has(v)) return asStrings ? v[REF] : v;
        if (Array.isArray(v)) return v.map(function (e) { return cloneTemplate(e, asStrings); });
        var out = {};
        for (var k in v) out[k] = cloneTemplate(v[k], asStrings);
        return out;
    }
    Object.defineProperty(JSON, "parse", {
        configurable: true, writable: true, enumerable: false,
        value: function (text) {
            if (active) {
                var t = typeof text === "string" ? text : text instanceof String ? strValueOf.call(text) : undefined;
                if (t !== undefined && templates.has(t)) return cloneTemplate(templates.get(t), g[AS_STRINGS] === true);
                for (var i = 0; i < arguments.length; i++) {
                    var info = refInfo(arguments[i]);
                    if (info) throw new OutputAccessError(info, "JSON.parse()");
                }
            }
            return jsonParse.apply(this, arguments);
        },
    });
    // Reading a property a string doesn't have (ref.httpTokens) goes through this proxy: that is reading into an
    // output, not comparing it.
    var baseProto = Object.getPrototypeOf(strProto);
    Object.setPrototypeOf(strProto, new Proxy(baseProto, {
        get: function (t, k, recv) {
            if (active && typeof k === "string" && !(k in t)) {
                var info = refInfo(recv);
                if (info) throw new OutputAccessError(info, "." + k);
            }
            return Reflect.get(t, k, recv);
        },
    }));

    // __unknown returns the identifiable unknown for a ref (the same object for the same ref, until __endInput).
    g.__unknown = function (ref, info) {
        var u = unknowns.get(ref);
        if (u) return u;
        var toPrimitive = function (hint) {
            if (hint === "string") return ref;
            throw new OutputAccessError(info, hint === "number" ? "numeric use" : "+ or == with a value");
        };
        var toJSON = function () { return ref; };
        var deny = function (label) { return function () { throw new OutputAccessError(info, label); }; };
        u = new Proxy(Object.freeze(Object.create(null)), {
            get: function (t, k) {
                if (k === Symbol.toPrimitive) return toPrimitive;
                if (k === "toJSON") return toJSON;
                if (k === REF) return ref;
                throw new OutputAccessError(info, typeof k === "symbol" ? "iteration or inspection" : "." + k);
            },
            has: deny("the in operator"),
            ownKeys: deny("listing its keys"),
            set: deny("assignment"),
            defineProperty: deny("assignment"),
            deleteProperty: deny("deletion"),
        });
        unknowns.set(ref, u);
        unknownInfo.set(u, info);
        refs.set(ref, info);
        return u;
    };

    // __template registers a JSON template's document and returns its text.
    g.__template = function (tree) {
        var text = JSON.stringify(tree);
        templates.set(text, tree);
        return text;
    };

    // __beginInput turns the guards on for the v2 policies about to run; __endInput turns them off and forgets the
    // identifiable unknowns.
    g.__beginInput = function (refTable) {
        for (var k in refTable) refs.set(k, refTable[k]);
        active = true;
    };
    g.__endInput = function () {
        active = false;
        refs = new Map();
        unknowns = new Map();
        templates = new Map();
    };

    // __invoke runs one policy's validate and returns
    // {v: [[msgOrObj, urn]...], p: [urn...], na?: string, unk?: string, out?: string, outUrn?: string}.
    // ABI v2 policies get {reportViolation, reportPass}: outcomes are explicit, and reporting nothing means not
    // applicable. ABI v1 policies get {reportViolation, notApplicable}.
    g.__invoke = function (fn, input, v2) {
        var v = [], p = [];
        var res = { v: v, p: p };
        var defUrn = input && input.resource ? input.resource.urn : undefined;
        function urnOr(urn) { return urn === undefined || urn === null ? defUrn : urn; }
        var ctx = v2 ? {
            reportViolation: function (m, urn) { v.push([m, urnOr(urn)]); },
            reportPass: function (urn) { p.push(urnOr(urn)); },
        } : {
            reportViolation: function (m, urn) { v.push([m, urnOr(urn)]); },
            notApplicable: function (reason) { throw new NotApplicable(reason); },
        };
        touched = null;
        reported = v;
        passed = p;
        try {
            fn(input, ctx);
        } catch (e) {
            if (e instanceof NotApplicable) {
                res.na = e.reason === undefined || e.reason === null ? "" : String(e.reason);
            } else if (e && e.name === "UnknownValueError") {
                res.unk = e.message;
                res.outUrn = defUrn;
            } else if (e && e.name === "OutputAccessError") {
                res.out = e.message;
                res.outUrn = defUrn;
            } else {
                throw e;
            }
        } finally {
            reported = null;
            passed = null;
        }
        if (touched && res.unk === undefined && res.out === undefined) {
            // The policy caught the error and carried on: keep what it reported before, and flag the rest.
            v.length = touched.vAt;
            p.length = touched.pAt;
            delete res.na;
            res[touched.kind] = touched.message;
            res.outUrn = defUrn;
        }
        touched = null;
        return res;
    };

    g.__describe = function () {
        var p = g.__pulumiPolicyPack;
        if (!p || typeof p !== "object") {
            throw new Error("policy pack bundle did not set globalThis.__pulumiPolicyPack");
        }
        return JSON.stringify(p, function (k, val) { return k === "validate" ? undefined : val; });
    };
})(globalThis);
