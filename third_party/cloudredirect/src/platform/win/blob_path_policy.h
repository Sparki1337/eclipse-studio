#pragma once
// Portable namespace/path policy, tested without loading the injected DLL.
#include <charconv>
#include <cstdint>
#include <string>
#include <string_view>
#include <algorithm>
#include <cctype>
namespace BlobPathPolicy {
inline bool ParseId(std::string_view value, uint32_t& result) {
    if (value.empty() || value.front() < '1' || value.front() > '9') return false;
    uint32_t parsed = 0;
    auto conversion = std::from_chars(value.data(), value.data() + value.size(), parsed);
    if (conversion.ec != std::errc{} || conversion.ptr != value.data() + value.size() || parsed == 0) return false;
    result = parsed; return true;
}
inline bool Filename(std::string_view value) {
    if (value.empty() || value.size() > 1024 || value.front() == '/' || value.front() == '\\') return false;
    size_t offset = 0;
    while (offset < value.size()) {
        auto end = value.find_first_of("/\\", offset);
        if (end == std::string_view::npos) end = value.size();
        auto part = value.substr(offset, end - offset);
        if (part.empty() || part == "." || part == ".." || part.back() == '.' || part.back() == ' ') return false;
        for (unsigned char c : part) if (c < 32 || c == 127 || c == ':' || c == '<' || c == '>' || c == '"' || c == '|' || c == '?' || c == '*') return false;
        auto stem = part.substr(0, part.find('.'));
        std::string upper(stem);
        std::transform(upper.begin(), upper.end(), upper.begin(), [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
        if (upper == "CON" || upper == "PRN" || upper == "AUX" || upper == "NUL" ||
            (upper.size() == 4 && (upper.substr(0, 3) == "COM" || upper.substr(0, 3) == "LPT") && upper[3] >= '1' && upper[3] <= '9')) return false;
        if (end == value.size()) return true;
        offset = end + 1;
        if (offset == value.size()) return false;
    }
    return false;
}
} // namespace BlobPathPolicy
