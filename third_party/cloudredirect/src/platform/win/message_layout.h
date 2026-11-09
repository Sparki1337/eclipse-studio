#pragma once
#include <cstddef>
#include <cstdint>

// Разметка обёртки выводится из кода пересылки slot 5 самого Steam, а не из
// номера сборки Steam как гарантии ABI. Неизвестная разметка не должна
// устанавливать хуки, которые могут принять заголовок за запрос сохранения.
namespace CgsMessageLayout {
struct Layout { uint32_t header = 0, body = 0; };
inline bool Resolve(const uint8_t* code, size_t size, Layout& result) {
    if (!code || size < 15) return false;
    Layout found{};
    for (size_t i = 0; i + 11 <= size; ++i) {
        // mov r9,[r9+body]; mov r8,[r8+body]; call [rax+20h] — пересылка slot 5
        if (code[i] != 0x4d || code[i+1] != 0x8b || code[i+2] != 0x49 ||
            code[i+4] != 0x4d || code[i+5] != 0x8b || code[i+6] != 0x40 ||
            code[i+3] != code[i+7] || code[i+8] != 0xff ||
            code[i+9] != 0x50 || code[i+10] != 0x20) continue;
        const uint32_t body = code[i+3];
        if (body != 0x30 && body != 0x38) return false;
        bool headerFound = false;
        const size_t start = i > 48 ? i - 48 : 0;
        for (size_t j = start; j + 4 <= i; ++j) {
            // mov rax,[r8+header] — чтение header.routing_appid.
            if (code[j] == 0x49 && code[j+1] == 0x8b && code[j+2] == 0x40 &&
                code[j+3] == body - 8) headerFound = true;
        }
        if (!headerFound || (found.body && found.body != body)) return false;
        found = {body - 8, body};
    }
    if (!found.body) return false;
    result = found;
    return true;
}
}
