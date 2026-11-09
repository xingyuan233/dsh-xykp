// qqbridge.cpp —— 注入到 QQ.exe 的桥 DLL（2026-10-27 原型 v3）
//
// 目标：在 QQ 主进程里执行我们自己的 JS（不碰 resources/app，绕过文件签名）。
//
// 机制：
//   ① DLL 注入 QQ.exe（injector.exe）
//   ② hook QQNT.dll 的 napi_create_string_utf8 —— 每次被调时顺便看一眼脚本文件有没有更新
//   ③ 有更新就把文件内容 napi_run_script 进主进程
//   ④ 脚本里 require wrapper.node，自己用 NodeIQQNTWrapperEngine / NodeIKernelLoginService / session 接口
//
// v3 相比 v2：支持「热重载脚本」——改 qq-bridge-script.js 就行，不用重启 QQ、不用重新扫码。
#include <windows.h>
#include <cstdio>
#include <cstdarg>
#include <cstring>
#include <string>

#include "dobby.h"

#ifndef NAPI_AUTO_LENGTH
#define NAPI_AUTO_LENGTH ((size_t)-1)
#endif

static const wchar_t* kLogPath = L"D:\\AI\\DeepseekHarness\\workspaces\\alive-workspace\\qq-bridge.log";
static const char* kScriptPath = "D:\\AI\\DeepseekHarness\\workspaces\\alive-workspace\\qq-bridge-script.js";

static void Log(const char* fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    HANDLE h = CreateFileW(kLogPath, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                           OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h != INVALID_HANDLE_VALUE) {
        DWORD written = 0;
        SetFilePointer(h, 0, nullptr, FILE_END);
        WriteFile(h, buf, (DWORD)strlen(buf), &written, nullptr);
        CloseHandle(h);
    }
}

typedef void (*RegisterFn)(void* mod);
typedef int (*CreateStringFn)(void* env, const char* str, size_t len, void** result);
typedef int (*RunScriptFn)(void* env, void* script, void** result);

static RegisterFn g_originRegister = nullptr;
static CreateStringFn g_originCreateString = nullptr;
static RunScriptFn p_run_script = nullptr;
static volatile LONG g_inHook = 0;
static ULONGLONG g_lastCheck = 0;
static FILETIME g_lastWrite = {0, 0};

static void RunScriptFile(void* env) {
    if (!env || !g_originCreateString || !p_run_script) return;
    if (InterlockedCompareExchange(&g_inHook, 1, 0) != 0) return;  // 防重入

    HANDLE h = CreateFileA(kScriptPath, GENERIC_READ,
                           FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) {
        InterlockedExchange(&g_inHook, 0);
        return;
    }
    FILETIME wt = {0, 0};
    GetFileTime(h, nullptr, nullptr, &wt);
    if (wt.dwLowDateTime == g_lastWrite.dwLowDateTime && wt.dwHighDateTime == g_lastWrite.dwHighDateTime) {
        CloseHandle(h);
        InterlockedExchange(&g_inHook, 0);
        return;
    }
    DWORD size = GetFileSize(h, nullptr);
    if (size == 0 || size > 200 * 1024) {
        CloseHandle(h);
        InterlockedExchange(&g_inHook, 0);
        return;
    }
    std::string buf(size, 0);
    DWORD read = 0;
    BOOL ok = ReadFile(h, &buf[0], size, &read, nullptr);
    CloseHandle(h);
    if (!ok || read == 0) {
        InterlockedExchange(&g_inHook, 0);
        return;
    }
    g_lastWrite = wt;

    void* script = nullptr;
    int rc = g_originCreateString(env, buf.c_str(), NAPI_AUTO_LENGTH, &script);
    Log("[bridge] hot-reload: compile rc=%d (%lu bytes)\n", rc, (unsigned long)read);
    if (rc == 0) {
        void* result = nullptr;
        int rc2 = p_run_script(env, script, &result);
        Log("[bridge] hot-reload: run rc=%d\n", rc2);
    }
    InterlockedExchange(&g_inHook, 0);
}

static int Hook_CreateString(void* env, const char* str, size_t len, void** result) {
    if (!g_inHook) {
        ULONGLONG now = GetTickCount64();
        if (now - g_lastCheck >= 3000) {
            g_lastCheck = now;
            RunScriptFile(env);
        }
    }
    return g_originCreateString(env, str, len, result);
}

static void Hook_Register(void* mod) {
    Log("[bridge] qq_magic_napi_register mod=%p\n", mod);
    if (g_originRegister) g_originRegister(mod);
}

static DWORD WINAPI Worker(LPVOID) {
    HMODULE qqnt = nullptr;
    for (int i = 0; i < 600; i++) {
        qqnt = GetModuleHandleW(L"QQNT.dll");
        if (qqnt) break;
        Sleep(50);
    }
    if (!qqnt) {
        Log("[bridge] QQNT.dll not loaded after 30s\n");
        return 0;
    }
    Log("[bridge] QQNT.dll=%p\n", (void*)qqnt);

    void* reg = (void*)GetProcAddress(qqnt, "qq_magic_napi_register");
    if (reg) {
        int rc = DobbyHook(reg, (void*)Hook_Register, (void**)&g_originRegister);
        Log("[bridge] hook register rc=%d\n", rc);
    }
    p_run_script = (RunScriptFn)GetProcAddress(qqnt, "napi_run_script");
    void* createString = (void*)GetProcAddress(qqnt, "napi_create_string_utf8");
    if (createString) {
        int rc = DobbyHook(createString, (void*)Hook_CreateString, (void**)&g_originCreateString);
        Log("[bridge] hook create_string rc=%d\n", rc);
    }
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        Log("[bridge] DLL attached pid=%lu\n", GetCurrentProcessId());
        CreateThread(nullptr, 0, Worker, nullptr, 0, nullptr);
    }
    return TRUE;
}
