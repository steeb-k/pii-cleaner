import Foundation

public enum PIIType: String, CaseIterable, Codable {
    case HOST, USER, DOMAIN, EMAIL, IP, MAC, SID, ID, PATH, URL, PHONE, CUSTOM
}

public struct Leak: Codable, Equatable {
    public let value: String
    public let type: String
    public let context: String
}

public struct Stats: Codable, Equatable {
    public let byType: [String: Int]
    public let total: Int
}

public struct SanitizeResult: Codable, Equatable {
    public let output: String
    public let format: String
    public let records: Int
    public let stats: Stats
    public let leaks: [Leak]
    public let warning: String?
    public let error: String?

    public init(output: String, format: String, records: Int, stats: Stats, leaks: [Leak], warning: String?, error: String?) {
        self.output = output; self.format = format; self.records = records
        self.stats = stats; self.leaks = leaks; self.warning = warning; self.error = error
    }
}

public struct LegendImportResult: Codable, Equatable {
    public let imported: Int
    public let skipped: Int
}

public enum PIICoreError: Error {
    case contextFailed
    case scriptMissing(String)
    case apiMissing(String)
    case jsException(String)
    case decodeFailed(String)
}
