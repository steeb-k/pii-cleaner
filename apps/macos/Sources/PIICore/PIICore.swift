import Foundation
import JavaScriptCore

/// Bridge to the shared JS core. One JSContext, one session. Calls are serialized on a private queue.
public final class PIICore {
    public static let types: [PIIType] = PIIType.allCases

    private let queue = DispatchQueue(label: "com.obfuscate.core")
    private let ctx: JSContext
    private let session: JSValue
    private var lastException: String?
    private let stringifyWellFormed: JSValue

    public init(scriptURL: URL) throws {
        guard let ctx = JSContext() else { throw PIICoreError.contextFailed }
        guard let src = try? String(contentsOf: scriptURL, encoding: .utf8) else {
            throw PIICoreError.scriptMissing(scriptURL.path)
        }
        var captured: String?
        ctx.exceptionHandler = { _, e in captured = e?.toString() ?? "unknown JS exception" }
        ctx.evaluateScript(src)
        if let c = captured { throw PIICoreError.jsException(c) }
        guard let ns = ctx.objectForKeyedSubscript("PIISanitizer"), !ns.isUndefined,
              let create = ns.objectForKeyedSubscript("createSession"), !create.isUndefined,
              let s = create.call(withArguments: []), s.isObject else {
            throw PIICoreError.apiMissing("PIISanitizer.createSession")
        }
        // JSON.stringify that replaces lone UTF-16 surrogates with U+FFFD. The core slices leak
        // `context` by UTF-16 index and can cut an emoji in half; a lone surrogate escape like
        // "\\udd25" is rejected by JSONDecoder and would otherwise fail the whole sanitize call.
        guard let wf = ctx.evaluateScript("""
            (function (v) {
              function fix(s) {
                if (typeof s.toWellFormed === 'function') return s.toWellFormed();
                return s.replace(/[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[\\uD800-\\uDFFF]/g,
                                 function (m) { return m.length === 2 ? m : '\\uFFFD'; });
              }
              return JSON.stringify(v, function (k, x) { return typeof x === 'string' ? fix(x) : x; });
            })
            """), wf.isObject, captured == nil else {
            throw PIICoreError.apiMissing("well-formed JSON.stringify helper")
        }
        self.ctx = ctx
        self.session = s
        self.stringifyWellFormed = wf
        ctx.exceptionHandler = { [weak self] _, e in self?.lastException = e?.toString() ?? "unknown JS exception" }
    }

    public convenience init() throws {
        guard let url = CoreScript.locate() else { throw PIICoreError.scriptMissing("sanitizer.js") }
        try self.init(scriptURL: url)
    }

    // MARK: helpers (call only inside queue.sync)

    private func jsonString(_ v: JSValue?) -> String? {
        guard let v = v, !v.isUndefined, !v.isNull else { return nil }
        return stringifyWellFormed.call(withArguments: [v])?.toString()
    }

    private func callSession(_ method: String, _ args: [Any]) throws -> JSValue {
        lastException = nil
        guard let fn = session.objectForKeyedSubscript(method), !fn.isUndefined else {
            throw PIICoreError.apiMissing(method)
        }
        let r = fn.call(withArguments: args)
        if let e = lastException { lastException = nil; throw PIICoreError.jsException(e) }
        guard let r = r else { throw PIICoreError.apiMissing(method) }
        return r
    }

    private func failure(_ message: String) -> SanitizeResult {
        SanitizeResult(output: "", format: "text", records: 0,
                       stats: Stats(byType: [:], total: 0), leaks: [], warning: nil, error: message)
    }

    // MARK: API

    public func sanitize(_ text: String, enabled: [PIIType: Bool] = [:], filename: String? = nil) -> SanitizeResult {
        queue.sync {
            var opts: [String: Any] = [:]
            var en: [String: Bool] = [:]
            for (k, v) in enabled { en[k.rawValue] = v }
            opts["enabled"] = en
            if let f = filename { opts["filename"] = f }
            do {
                let optsJSON = String(data: try JSONSerialization.data(withJSONObject: opts), encoding: .utf8) ?? "{}"
                let parsed = ctx.objectForKeyedSubscript("JSON")?.objectForKeyedSubscript("parse")?
                    .call(withArguments: [optsJSON]) ?? JSValue(newObjectIn: ctx)
                let r = try callSession("sanitize", [text, parsed as Any])
                guard let s = jsonString(r), let data = s.data(using: .utf8) else {
                    return failure("sanitize returned no result")
                }
                return try JSONDecoder().decode(SanitizeResult.self, from: data)
            } catch {
                return failure("\(error)")
            }
        }
    }

    public func importLegend(json: String) throws -> LegendImportResult {
        try queue.sync {
            lastException = nil
            guard let parse = ctx.objectForKeyedSubscript("JSON")?.objectForKeyedSubscript("parse") else {
                throw PIICoreError.apiMissing("JSON.parse")
            }
            let parsed = parse.call(withArguments: [json])
            if let e = lastException { lastException = nil; throw PIICoreError.jsException(e) }
            let r = try callSession("importLegend", [parsed as Any])
            guard let s = jsonString(r), let data = s.data(using: .utf8) else {
                throw PIICoreError.decodeFailed("importLegend")
            }
            do { return try JSONDecoder().decode(LegendImportResult.self, from: data) }
            catch { throw PIICoreError.decodeFailed("\(error)") }
        }
    }

    public func exportLegendJSON() -> String {
        queue.sync {
            guard let r = try? callSession("exportLegend", []),
                  let json = ctx.objectForKeyedSubscript("JSON")?.objectForKeyedSubscript("stringify"),
                  let s = json.call(withArguments: [r, NSNull(), 2])?.toString() else { return "" }
            return s + "\n"
        }
    }

    public func exportLegendCSV() -> String {
        queue.sync { (try? callSession("exportLegendCSV", []))?.toString() ?? "" }
    }

    public func addCustom(type: PIIType, values: [String]) throws {
        guard [.HOST, .USER, .DOMAIN, .CUSTOM].contains(type) else {
            throw PIICoreError.jsException("addCustom does not support \(type.rawValue)")
        }
        try queue.sync { _ = try callSession("addCustom", [type.rawValue, values]) }
    }

    public func clear() {
        queue.sync { _ = try? callSession("clear", []) }
    }

    public func detectFormat(_ text: String) -> String {
        queue.sync {
            ctx.objectForKeyedSubscript("PIISanitizer")?.objectForKeyedSubscript("detectFormat")?
                .call(withArguments: [text])?.toString() ?? "text"
        }
    }
}
