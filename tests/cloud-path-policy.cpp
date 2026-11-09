// cloud-path-policy — проверка политики имён файлов и путей облака
#include "../third_party/cloudredirect/src/platform/win/blob_path_policy.h"
#include <cassert>
#include <iostream>
int main() {
    uint32_t id = 0;
    assert(BlobPathPolicy::ParseId("4294967295", id) && id == 4294967295u);
    for (auto value : {"0", "-1", "+1", " 1", "01", "4294967296", "1x", ""}) assert(!BlobPathPolicy::ParseId(value, id));
    for (auto value : {"save.dat", "folder/save.bin", "folder\\save.bin", "SteamSave.v2"}) assert(BlobPathPolicy::Filename(value));
    for (auto value : {"../other/save", "folder/../../save", "folder\\..\\save", "/absolute", "\\absolute", "a//b", "a/", "a:stream", "NUL.txt", "folder/COM1.dat", "x. ", "a/./b", "a\n"}) assert(!BlobPathPolicy::Filename(value));
    std::string nul("a\0b", 3); assert(!BlobPathPolicy::Filename(nul));
    std::cout << "PASS: политика пространства имён и путей облака" << std::endl;
}
