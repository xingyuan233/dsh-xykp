// injector.cpp —— 启动 QQ.exe 并注入 qqbridge.dll
//
// 用法：injector.exe <QQ.exe 路径> <qqbridge.dll 路径> [QQ 参数...]
// 原理：CreateProcess(SUSPENDED) → VirtualAllocEx/WriteProcessMemory →
//       CreateRemoteThread(LoadLibraryW) → ResumeThread
#include <windows.h>
#include <cstdio>

static void Log(const wchar_t* msg) {
    wprintf(L"[injector] %ls\n", msg);
}

int wmain(int argc, wchar_t** argv) {
    if (argc < 3) {
        wprintf(L"usage: injector.exe <QQ.exe> <bridge.dll> [args...]\n");
        return 2;
    }
    const wchar_t* exe = argv[1];
    const wchar_t* dll = argv[2];

    wchar_t cwd[MAX_PATH];
    wcscpy_s(cwd, exe);
    wchar_t* slash = wcsrchr(cwd, L'\\');
    if (slash) *slash = 0;

    // 参数：把 QQ 自己的参数拼起来（这里简单处理：原样拼）
    wchar_t cmd[4096];
    cmd[0] = 0;
    wcscat_s(cmd, L"\"");
    wcscat_s(cmd, exe);
    wcscat_s(cmd, L"\"");
    for (int i = 3; i < argc; i++) {
        wcscat_s(cmd, L" ");
        wcscat_s(cmd, argv[i]);
    }

    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi = {};
    if (!CreateProcessW(exe, cmd, nullptr, nullptr, FALSE, CREATE_SUSPENDED, nullptr, cwd, &si, &pi)) {
        wprintf(L"[injector] CreateProcess failed: %lu\n", GetLastError());
        return 1;
    }
    wprintf(L"[injector] started pid=%lu\n", pi.dwProcessId);

    size_t bytes = (wcslen(dll) + 1) * sizeof(wchar_t);
    void* remote = VirtualAllocEx(pi.hProcess, nullptr, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remote) {
        wprintf(L"[injector] VirtualAllocEx failed: %lu\n", GetLastError());
        TerminateProcess(pi.hProcess, 1);
        return 1;
    }
    if (!WriteProcessMemory(pi.hProcess, remote, dll, bytes, nullptr)) {
        wprintf(L"[injector] WriteProcessMemory failed: %lu\n", GetLastError());
        TerminateProcess(pi.hProcess, 1);
        return 1;
    }

    HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
    void* loadLib = (void*)GetProcAddress(k32, "LoadLibraryW");
    HANDLE th = CreateRemoteThread(pi.hProcess, nullptr, 0, (LPTHREAD_START_ROUTINE)loadLib, remote, 0, nullptr);
    if (!th) {
        wprintf(L"[injector] CreateRemoteThread failed: %lu\n", GetLastError());
        TerminateProcess(pi.hProcess, 1);
        return 1;
    }
    WaitForSingleObject(th, 30000);
    CloseHandle(th);

    ResumeThread(pi.hThread);
    wprintf(L"[injector] resumed\n");
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return 0;
}
