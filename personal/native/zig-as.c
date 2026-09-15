/* One-time snapshot of Team DevSpace 15ce088 native/tray/zig-as.c. Build helper only. */
#include <process.h>
#include <stdlib.h>
#include <wchar.h>
int wmain(int argc, wchar_t **argv) {
  wchar_t *zig = _wgetenv(L"PERSONAL_ZIG"); if (!zig || argc < 2) return 2;
  wchar_t **arguments = calloc((size_t)argc + 5, sizeof(wchar_t *)); if (!arguments) return 3;
  arguments[0] = zig; arguments[1] = L"cc"; arguments[2] = L"-target"; arguments[3] = L"x86_64-windows-gnu"; arguments[4] = L"-c";
  int output = 5; for (int i = 1; i < argc; i++) if (wcscmp(argv[i], L"--64") != 0) arguments[output++] = argv[i];
  int result = _wspawnv(_P_WAIT, zig, (const wchar_t *const *)arguments); free(arguments); return result < 0 ? 4 : result;
}
